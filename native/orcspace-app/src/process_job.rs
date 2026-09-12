/// Keep terminal descendants inside the engine's lifetime even after a crash.
#[cfg(windows)]
pub fn contain_engine_process() -> std::io::Result<()> {
    use std::{mem, ptr};
    use winapi::um::{
        handleapi::CloseHandle,
        jobapi2::{AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject},
        processthreadsapi::GetCurrentProcess,
        winnt::{JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE},
    };

    // The handle is not inheritable. It intentionally stays open until process
    // exit: Windows then closes it and terminates the remaining descendants.
    // Closing it in a Rust destructor would also terminate this engine before
    // normal shutdown had returned its exit code.
    unsafe {
        let job = CreateJobObjectW(ptr::null_mut(), ptr::null());
        if job.is_null() { return Err(std::io::Error::last_os_error()); }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(job, JobObjectExtendedLimitInformation,
            &mut limits as *mut _ as *mut _, mem::size_of_val(&limits) as u32) == 0
            || AssignProcessToJobObject(job, GetCurrentProcess()) == 0 {
            let error = std::io::Error::last_os_error();
            CloseHandle(job);
            return Err(error);
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn contain_engine_process() -> std::io::Result<()> { Ok(()) }
