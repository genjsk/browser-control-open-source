# Contributing

Use Node.js 22 or newer. Run `npm ci`, `npm run check` and `npm test`. Browser changes also require `npx playwright install chromium` followed by `npm run test:browser`. Tests use isolated data directories and ports, never your ordinary browser profile.

Python GUI changes require `python -m pip install -r requirements-build.txt` and `python scripts/build-gui.py`. Test the resulting portable folder, including relocation to a path with spaces/non-ASCII characters and a PATH without Node.js. Keep the native Windows title-bar/taskbar icon handling.

Do not commit runtime data, pairing keys, client configuration dumps, private site URLs or screenshots. Run `npm run prepare:release` before opening a pull request. Public documentation should use generated/runtime-relative paths, not a contributor's machine paths.

Submit a pull request describing the user-visible change and relevant validation. Changes to permissions, origin boundaries, pairing, credential handling and automatic restart behavior need corresponding behavioral tests.
