# Third-party notices

The bundled MCP runtime includes open-source Node.js components. Their package names, versions, declared license identifiers, and copied license files are listed in `licenses/node/index.json` in the distributable package.

The optional local Vision Compiler setup installs pinned Python distributions from `python/requirements.txt`:

- NumPy 2.2.6, BSD-3-Clause, including notices carried by its binary distribution.
- opencv-contrib-python-headless 5.0.0.93, Apache-2.0.

Python wheels are not redistributed in the plugin package; `scripts/setup-python.mjs` installs them into the user's local `.venv`, where their complete metadata and license notices remain available. Chrome/Chromium and FFmpeg are native prerequisites supplied separately and retain their own terms.
