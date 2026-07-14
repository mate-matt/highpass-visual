# Compile Vision Assets offline

Highpass Visual compiles each Selected Image into a cached Vision Asset with native OpenCV before playback. Browser renderers consume textures, paths, and metadata without running OpenCV or reading GPU frames back to the CPU every frame; this preserves complete `ximgproc` capability, deterministic artifacts, and smooth runtime performance at the cost of a compilation step and a native Python dependency.
