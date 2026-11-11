#!/usr/bin/env python3
"""Provision the isolated public VCN used by the OmniCodex A1 host.

The command is deliberately idempotent and only owns resources with the exact
names below.  It never reads or mutates the trading VCN, subnet, route table,
or security list.
"""

from __future__ import annotations

import argparse
import json
from typing import Any, Iterable, TypeVar

import oci


VCN_NAME = "omnicodex-a1-vcn"
VCN_CIDR = "10.77.0.0/16"
VCN_DNS_LABEL = "omnicodexa1"
SUBNET_NAME = "omnicodex-a1-public-subnet"
SUBNET_CIDR = "10.77.1.0/24"
SUBNET_DNS_LABEL = "public"
INTERNET_GATEWAY_NAME = "omnicodex-a1-internet-gateway"

T = TypeVar("T")


def one_or_none(values: Iterable[T], label: str) -> T | None:
    matches = list(values)
    if len(matches) > 1:
        raise RuntimeError(f"refusing ambiguous {label}: {len(matches)} matches")
    return matches[0] if matches else None


def wait_available(client: Any, getter: Any, resource_id: str) -> Any:
    return oci.wait_until(
        client,
        getter(resource_id),
        "lifecycle_state",
        "AVAILABLE",
        max_wait_seconds=600,
    ).data


def tcp_ingress(port: int) -> Any:
    return oci.core.models.IngressSecurityRule(
        protocol="6",
        source="0.0.0.0/0",
        source_type="CIDR_BLOCK",
        tcp_options=oci.core.models.TcpOptions(
            destination_port_range=oci.core.models.PortRange(min=port, max=port)
        ),
        description=f"OmniCodex TCP {port}",
    )


def provision(config_file: str, profile: str) -> dict[str, str]:
    config = oci.config.from_file(config_file, profile)
    oci.config.validate_config(config)
    compartment_id = config["tenancy"]
    network = oci.core.VirtualNetworkClient(config)

    vcn = one_or_none(
        (
            item
            for item in oci.pagination.list_call_get_all_results(
                network.list_vcns,
                compartment_id,
                display_name=VCN_NAME,
            ).data
            if item.lifecycle_state != "TERMINATED"
        ),
        f"VCN named {VCN_NAME!r}",
    )
    if vcn is None:
        vcn = network.create_vcn(
            oci.core.models.CreateVcnDetails(
                compartment_id=compartment_id,
                display_name=VCN_NAME,
                cidr_blocks=[VCN_CIDR],
                dns_label=VCN_DNS_LABEL,
                is_ipv6_enabled=False,
            ),
            opc_retry_token="omnicodex-a1-vcn-v1",
        ).data
        vcn = wait_available(network, network.get_vcn, vcn.id)
    if list(vcn.cidr_blocks or []) != [VCN_CIDR]:
        raise RuntimeError(f"existing {VCN_NAME} does not own {VCN_CIDR}")

    gateway = one_or_none(
        (
            item
            for item in oci.pagination.list_call_get_all_results(
                network.list_internet_gateways,
                compartment_id,
                vcn_id=vcn.id,
                display_name=INTERNET_GATEWAY_NAME,
            ).data
            if item.lifecycle_state != "TERMINATED"
        ),
        f"internet gateway named {INTERNET_GATEWAY_NAME!r}",
    )
    if gateway is None:
        gateway = network.create_internet_gateway(
            oci.core.models.CreateInternetGatewayDetails(
                compartment_id=compartment_id,
                vcn_id=vcn.id,
                display_name=INTERNET_GATEWAY_NAME,
                is_enabled=True,
            ),
            opc_retry_token="omnicodex-a1-internet-gateway-v1",
        ).data
        gateway = wait_available(network, network.get_internet_gateway, gateway.id)

    network.update_route_table(
        vcn.default_route_table_id,
        oci.core.models.UpdateRouteTableDetails(
            route_rules=[
                oci.core.models.RouteRule(
                    network_entity_id=gateway.id,
                    destination="0.0.0.0/0",
                    destination_type="CIDR_BLOCK",
                    description="OmniCodex public egress",
                )
            ]
        ),
    )
    network.update_security_list(
        vcn.default_security_list_id,
        oci.core.models.UpdateSecurityListDetails(
            ingress_security_rules=[tcp_ingress(port) for port in (22, 80, 443)],
            egress_security_rules=[
                oci.core.models.EgressSecurityRule(
                    protocol="all",
                    destination="0.0.0.0/0",
                    destination_type="CIDR_BLOCK",
                    description="OmniCodex public egress",
                )
            ],
        ),
    )

    subnet = one_or_none(
        (
            item
            for item in oci.pagination.list_call_get_all_results(
                network.list_subnets,
                compartment_id,
                display_name=SUBNET_NAME,
            ).data
            if item.lifecycle_state != "TERMINATED"
        ),
        f"subnet named {SUBNET_NAME!r}",
    )
    if subnet is None:
        subnet = network.create_subnet(
            oci.core.models.CreateSubnetDetails(
                compartment_id=compartment_id,
                vcn_id=vcn.id,
                display_name=SUBNET_NAME,
                cidr_block=SUBNET_CIDR,
                dns_label=SUBNET_DNS_LABEL,
                prohibit_public_ip_on_vnic=False,
                prohibit_internet_ingress=False,
                route_table_id=vcn.default_route_table_id,
                security_list_ids=[vcn.default_security_list_id],
                dhcp_options_id=vcn.default_dhcp_options_id,
            ),
            opc_retry_token="omnicodex-a1-public-subnet-v1",
        ).data
        subnet = wait_available(network, network.get_subnet, subnet.id)
    if subnet.vcn_id != vcn.id or subnet.cidr_block != SUBNET_CIDR:
        raise RuntimeError(f"existing {SUBNET_NAME} is not the isolated OmniCodex subnet")

    return {
        "vcnId": vcn.id,
        "subnetId": subnet.id,
        "subnetName": subnet.display_name,
        "internetGatewayId": gateway.id,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config-file", default=str(oci.config.DEFAULT_LOCATION))
    parser.add_argument("--profile", default="OMNICODEX_A1")
    args = parser.parse_args()
    print(json.dumps(provision(args.config_file, args.profile), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
