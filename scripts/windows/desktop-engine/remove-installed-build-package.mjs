import { realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export async function removeInstalledBuildPackage(
  buildRoot,
  packageDirectory,
  installedExecutablePath,
) {
  const packageRoot = await realpath(join(resolve(buildRoot), "packages"));
  const packagePath = await realpath(packageDirectory);
  const installedPath = await realpath(installedExecutablePath);
  if (
    dirname(packagePath).toLowerCase() !== packageRoot.toLowerCase() ||
    !/^b-[a-f0-9]{8}$/iu.test(basename(packagePath)) ||
    !(await stat(packagePath)).isDirectory()
  ) {
    throw new Error("Build package cleanup path is outside its package root");
  }
  const installedWithinPackage = relative(packagePath, installedPath);
  if (
    installedWithinPackage === "" ||
    (!installedWithinPackage.startsWith("..") && !isAbsolute(installedWithinPackage))
  ) {
    throw new Error("Installed engine must remain outside the build package");
  }
  await rm(packagePath, { recursive: true });
}
