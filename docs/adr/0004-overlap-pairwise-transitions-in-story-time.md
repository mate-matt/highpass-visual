# Overlap pairwise transitions in Story Time

Pairwise Transition Programs simultaneously sample the outgoing Shot tail and incoming Shot head, so their duration is counted once in Story Time while each Shot retains its complete local Scene Time. Cuts and legacy fade-to-black do not overlap; Story duration is the sum of Shot durations minus pairwise overlap durations, which prevents repeated incoming frames and makes the transition mapping explicit in Quality Evidence.
