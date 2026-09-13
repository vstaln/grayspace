# Windows updates

Settings → Check for updates downloads the next stable version from
https://github.com/orcspace/Orcspace-Uptade/releases.
Restart and install applies it on explicit user action. Running terminals close.
Development builds and macOS are disabled; macOS releases currently lack signing.

NSIS uses differential downloads when the previous installer/blockmaps are
available, falling back to the full installer when necessary. Keep old release
assets. A large version change does not inherently require a full download.

## Publishing

1. In the source repository, configure the Actions secret `UPDATE_RELEASE_TOKEN`
   with a fine-grained token authorized for `orcspace/Orcspace-Uptade`, with
   Contents read/write permission. The source repository's default GITHUB_TOKEN
   cannot publish to this separate repository. Never bundle this token or SSH keys.
2. Increment package.json and package-lock.json versions together. Push a matching
   `v<version>` tag. The release workflow builds and tests Windows before uploading
   the installer, its `.exe.blockmap`, and `latest.yml` to the public release repo.
3. For a manual release, run `npm run installer:win` and attach those same three
   files to a release tagged `v<version>`. Publish after all files are uploaded.

Existing installations without the update configuration need one manual install
of this build. Verify updates with two installed Windows versions, including a
download with old assets available, a full-download fallback, network failure,
and an explicit restart. Typechecking alone cannot verify installer replacement.
