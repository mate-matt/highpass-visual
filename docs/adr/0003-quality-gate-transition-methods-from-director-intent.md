# Quality-gate transition methods from Director intent

Highpass Visual represents each boundary with a Director-authored Transition Intent and an optional locked method, while a Transition Compiler selects the concrete algorithm through measured compatibility and a deterministic fallback chain. This keeps narrative authority with the Director, lets safe automation choose among OpenCV implementations, and makes a locked method fail explicitly instead of silently changing the direction.
