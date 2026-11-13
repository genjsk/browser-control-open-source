# Third-party notices

This repository's original code, documentation and original AI-generated mascot assets are provided under the project MIT license. No third-party character, franchise logo or reference artwork was used for the mascot.

Dependencies retain their own licenses. The release contains their upstream license files under `node_modules`. The Windows portable build copies the currently selected Node.js executable and retrieves its matching upstream LICENSE into `third_party/NODE_LICENSE.txt`. The GUI build includes Python and PyInstaller license files when found in the build installation, plus Tcl/Tk notices when available there.

Maintainers must review redistribution notices when upgrading runtime versions. The GUI build tool is [PyInstaller](https://pyinstaller.org/), whose bootloader includes a special distribution exception; Python, Tcl/Tk and Node.js use their respective upstream licenses. Do not replace those notices with this project's MIT license.

The release build performs no public upload by itself. GitHub publication only runs on a pushed version tag in the release workflow, or when the maintainer separately uploads a tested artifact.
