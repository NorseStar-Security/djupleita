# Portable Djupleita releases

Download the archive for your operating system and CPU from
[GitHub Releases](https://github.com/NorseStar-Security/djupleita/releases).
Linux and macOS archives are available for x64 and ARM64. These distributions run
the full browser interface and include Node.js and the built application.

Extract into a directory owned by your user, then run:

```sh
tar -xzf djupleita-0.2.0-linux-x64.tar.gz
cd djupleita-0.2.0-linux-x64
./djupleita
```

Use the matching filename on ARM64 or macOS. On macOS you can also open
`Djupleita.command`. Open the authenticated loopback URL printed in the terminal.
Keep the terminal running and stop with Ctrl-C. The URL contains a private access
token; do not share it. Configure your own provider in the interface.

Linux requires glibc (Ubuntu 22.04 or newer is supported), bash, bubblewrap, D-Bus,
and Secret Service for stored credentials. On Ubuntu/Debian install prerequisites:

```sh
sudo apt-get install bubblewrap dbus-x11 gnome-keyring libsecret-tools python3-venv curl unzip zip
```

Run as a regular user in a session with Secret Service available. macOS requires
macOS 15 or newer. The portable macOS download uses the browser interface; the
native desktop development launcher remains available from the source checkout.

Optional managed tools are installed through the setup controls in the interface,
or from the terminal:

```sh
./djupleita setup --only browser
./djupleita setup --only recon
./djupleita setup --only ffuf
./djupleita setup --only rea
./djupleita setup --only learning --python /absolute/path/to/python3
```

Browser automation also needs the system libraries required by Playwright Chromium.
Learning needs Python 3.10 or newer with venv support. These optional downloads
require internet access. No provider credentials or assessment data are included.

Local configuration, credentials and assessment state are stored privately under
`app/.pentest` in the extracted directory. Stop the old version before upgrading;
back up this directory and restore it to the new archive's `app/.pentest` before
launching. Rerun managed tool setup after moving an installation so stored tool paths
point to the new directory. Keep this data out of source control and shared archives.

Check the archive against `SHA256SUMS` from the same release before extracting:

```sh
sha256sum --ignore-missing -c SHA256SUMS
# macOS: shasum -a 256 -c SHA256SUMS
```

`./djupleita --version` prints the version and source revision without launching.
`release.json` records the runtime, pinned harness revision and dependency inventory.
Third-party licenses are retained alongside their packages and the Node runtime.
