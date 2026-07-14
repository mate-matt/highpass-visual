# Use absolute Scene Time and fixed-frame export

Every Shot Program is sampled from absolute Scene Time, and export samples frame `n` at `n / fps` before FFmpeg encoding. Realtime browser clocks may control preview playback but never own narrative state; this makes seeking, repeatable review, resume, exact frame counts, and renderer-independent Quality Evidence possible.
