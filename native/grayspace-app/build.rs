use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=GRAYSPACE_CONPTY_DIR");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let architecture = match env::var("CARGO_CFG_TARGET_ARCH").unwrap().as_str() {
        "x86_64" => "win10-x64",
        "aarch64" => "win10-arm64",
        other => panic!("Unsupported Windows architecture: {other}"),
    };
    let source = env::var_os("GRAYSPACE_CONPTY_DIR").map(PathBuf::from).unwrap_or_else(|| {
        manifest.join("../vendor/conpty").join(architecture)
    });
    let output = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let destination = output.ancestors().nth(3).expect("Cargo profile directory");
    for name in ["conpty.dll", "OpenConsole.exe"] {
        let source = source.join(name);
        println!("cargo:rerun-if-changed={}", source.display());
        let bytes = fs::read(&source).unwrap_or_else(|error| {
            panic!(
                "Cannot read {}: {error}. Set GRAYSPACE_CONPTY_DIR to the directory holding conpty.dll and OpenConsole.exe.",
                source.display()
            )
        });
        let target = destination.join(name);
        if fs::read(&target).ok().as_deref() != Some(bytes.as_slice()) {
            fs::write(&target, bytes)
                .unwrap_or_else(|error| panic!("Cannot write {}: {error}", target.display()));
        }
    }
}
