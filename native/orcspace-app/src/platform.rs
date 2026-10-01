use std::io::Write;
const CONPTY_CURSOR_REPORT: &[u8] = b"\x1b[1;1R";

pub fn prime_conpty_handshake(writer: &mut Box<dyn Write + Send>) {
    if !cfg!(windows) {
        return;
    }
    let _ = writer
        .write_all(CONPTY_CURSOR_REPORT)
        .and_then(|_| writer.flush());
}

pub fn kill_process_tree(pid: u32) -> bool {
    // 0 means "my own process group" to kill(2) and "the current process" to
    // parts of the Win32 API. Never let one through: the engine would be
    // taking itself, and every terminal it owns, down with it.
    if pid == 0 {
        return false;
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        /// The engine itself runs without a console, so Windows hands any
        /// console-subsystem child it starts a brand-new console window.
        /// Without this flag `taskkill` flashes a black window on screen
        /// every single time a terminal widget is closed.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        // portable-pty puts the shell in its own session (setsid, so the slave
        // can become the controlling terminal), which makes the shell's pid
        // its process-group id too — a negative pid therefore reaps every
        // descendant. This used to do nothing at all, leaving the actor's
        // `child.kill()` to take down the direct child only: agents, dev
        // servers and other grandchildren kept running headless after the
        // widget was closed, which is precisely what the Windows branch above
        // goes out of its way to prevent.
        let Ok(pid) = i32::try_from(pid) else {
            return false;
        };
        // SAFETY: kill(2) is async-signal-safe and only reports errors through
        // its return value; `pid` is non-zero and positive, so neither the
        // "own process group" nor the "every process" target can be selected.
        if unsafe { libc::kill(-pid, libc::SIGKILL) } == 0 {
            return true;
        }
        // Not a group leader, or the group is already gone: at least make sure
        // the shell itself is down.
        unsafe { libc::kill(pid, libc::SIGKILL) == 0 }
    }
}

pub fn interrupt_process_tree(pid: u32) -> bool {
    // 0 means "my own process group" to kill(2) and "the current process" to
    // parts of the Win32 API — never let one through.
    if pid == 0 {
        return false;
    }
    #[cfg(windows)]
    {
        // Windows cannot signal a process attached to someone else's
        // pseudoconsole, so the foreground program is terminated instead,
        // which is what Ctrl+C on an unresponsive terminal is asking for.
        // Only the shell's children go; the shell itself stays.
        let mut stopped = false;
        for child in direct_children(pid) {
            stopped |= kill_process_tree(child);
        }
        stopped
    }
    #[cfg(not(windows))]
    {
        let Ok(pid) = i32::try_from(pid) else {
            return false;
        };
        // SAFETY: kill(2) is async-signal-safe and reports errors through its
        // return value only; the pid is positive and non-zero, so neither the
        // "own process group" nor the "every process" target can be selected.
        // portable-pty puts the shell in its own session, so the negated pid
        // addresses that group: the shell ignores SIGINT as any interactive
        // shell does, and the job it is running takes it.
        unsafe { libc::kill(-pid, libc::SIGINT) == 0 }
    }
}

#[cfg(windows)]
pub fn direct_children(pid: u32) -> Vec<u32> {
    use winapi::um::handleapi::{CloseHandle, INVALID_HANDLE_VALUE};
    use winapi::um::tlhelp32::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let mut children = Vec::new();
    // SAFETY: the snapshot handle is checked against INVALID_HANDLE_VALUE
    // before use and closed on every path out; `entry` is zeroed with the
    // dwSize the API requires, and both walk calls only write into it.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return children;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                if entry.th32ParentProcessID == pid && entry.th32ProcessID != 0 {
                    children.push(entry.th32ProcessID);
                }
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
    }
    children
}

pub fn shell_arguments(shell: &str) -> Vec<&'static str> {
    #[cfg(windows)]
    {
        let lower = shell.to_ascii_lowercase();
        if lower.contains("powershell") || lower.contains("pwsh") {
            vec!["-NoLogo", "-NoExit", "-Command", "chcp 65001 > $null"]
        } else if lower
            .rsplit(['\\', '/'])
            .next()
            .is_some_and(|name| matches!(name, "cmd" | "cmd.exe"))
        {
            vec!["/K", "chcp 65001 >nul"]
        } else {
            Vec::new()
        }
    }
    #[cfg(not(windows))]
    {
        if std::path::Path::new(shell)
            .file_name()
            .is_some_and(|name| matches!(name.to_str(), Some("zsh" | "bash" | "sh" | "fish")))
        {
            vec!["-l"]
        } else {
            Vec::new()
        }
    }
}

pub fn shell_command() -> String {
    #[cfg(windows)]
    {
        std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_owned())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_owned())
    }
}

/// Keep terminal descendants inside the engine's lifetime even after a crash.
#[cfg(windows)]
pub fn contain_engine_process() -> std::io::Result<()> {
    use std::{mem, ptr};
    use winapi::um::{
        handleapi::CloseHandle,
        jobapi2::{AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject},
        processthreadsapi::GetCurrentProcess,
        winnt::{
            JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
    };

    // The handle is not inheritable. It intentionally stays open until process
    // exit: Windows then closes it and terminates the remaining descendants.
    // Closing it in a Rust destructor would also terminate this engine before
    // normal shutdown had returned its exit code.
    unsafe {
        let job = CreateJobObjectW(ptr::null_mut(), ptr::null());
        if job.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &mut limits as *mut _ as *mut _,
            mem::size_of_val(&limits) as u32,
        ) == 0
            || AssignProcessToJobObject(job, GetCurrentProcess()) == 0
        {
            let error = std::io::Error::last_os_error();
            CloseHandle(job);
            return Err(error);
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn contain_engine_process() -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_shells_do_not_receive_cmd_arguments() {
        assert!(shell_arguments("custom-shell").is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn bash_does_not_receive_cmd_arguments() {
        assert!(shell_arguments(r"C:\Program Files\Git\bin\bash.exe").is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn desktop_shells_load_login_environment() {
        assert_eq!(shell_arguments("/bin/zsh"), ["-l"]);
        assert_eq!(shell_arguments("/bin/bash"), ["-l"]);
    }
}
