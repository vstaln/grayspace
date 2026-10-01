# Windows and Linux installers

The release build targets x64 and uses the checked-in `package-lock.json`.
Installers are built on GitHub Actions, not on the developer machine.

Push a tag such as `v2.2.10` to start `.github/workflows/release.yml`. GitHub
builds Windows and Linux in parallel, runs typechecks/tests, smoke-checks each
packaged runtime, and publishes the artifacts to the GitHub release. The
release contains update metadata and SHA-256 manifests. Windows may show
SmartScreen because the installer is unsigned.

The Linux job produces an x64 AppImage, Debian package, portable `.tar.gz`,
and checksum manifest. The AppImage can be started after `chmod +x
OrcSpace-*.AppImage`; Debian and Ubuntu can install the `.deb` with `sudo apt
install ./OrcSpace-*.deb`.

The canonical download links are the assets on the `v2.2.10` GitHub release;
the workflow also mirrors them to `orcspace/Orcspace-Uptade` for in-app updates.
