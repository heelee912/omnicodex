#![windows_subsystem = "windows"]

use std::env;
use std::ffi::{c_void, OsStr};
use std::os::windows::ffi::OsStrExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[link(name = "user32")]
unsafe extern "system" {
    fn SendMessageTimeoutW(
        window: *mut c_void,
        message: u32,
        w_param: usize,
        l_param: isize,
        flags: u32,
        timeout_ms: u32,
        result: *mut usize,
    ) -> isize;
}

fn main() {
    let result = run();
    match result {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("OmniCodex Desktop engine bridge failed: {error}");
            std::process::exit(1);
        }
    }
}

fn run() -> Result<i32, Box<dyn std::error::Error>> {
    if env::args_os().nth(1).as_deref() == Some(OsStr::new("--broadcast-environment")) {
        let environment = OsStr::new("Environment")
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let mut result = 0usize;
        let sent = unsafe {
            SendMessageTimeoutW(
                0xffffusize as *mut c_void,
                0x1a,
                0,
                environment.as_ptr() as isize,
                0x2,
                5000,
                &mut result,
            )
        };
        if sent == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        return Ok(0);
    }
    let launcher = env::current_exe()?;
    let directory = launcher.parent().ok_or("launcher has no parent directory")?;
    let script = directory.join("stock-app-server-stdio.mjs");
    if !script.is_file() {
        return Err(format!("bridge script is missing: {}", script.display()).into());
    }
    let node = env::var_os("OMNICODEX_NODE_PATH")
        .map(PathBuf::from)
        .or_else(|| env::var_os("ProgramFiles").map(|root| PathBuf::from(root).join("nodejs").join("node.exe")))
        .unwrap_or_else(|| PathBuf::from("node.exe"));
    let status = Command::new(node)
        .arg(script)
        .args(env::args_os().skip(1))
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .creation_flags(CREATE_NO_WINDOW)
        .status()?;
    Ok(status.code().unwrap_or(1))
}
