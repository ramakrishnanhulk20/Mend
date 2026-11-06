# The art behind Mend

The hero film, the four clay scenes and the seven step icons are all made by the Python scripts in `world/`, run inside Blender 5.2.3. There is no stock art and nothing is modelled by hand: every house, stitch and coin is built in code, and a run writes its images to `world/out/`.

```bash
blender -b --python-exit-code 1 -P world/build.py -- --out out/still.png --width 1500 --height 750 --samples 96
blender -b --python-exit-code 1 -P world/animate.py -- --out-dir out/film --width 3000 --height 1500 --samples 128 --start 1 --end 312
blender -b --python-exit-code 1 -P world/scenes.py -- --scene 1 --out out/how-1.png --width 1600 --height 1200 --samples 128
blender -b --python-exit-code 1 -P world/icons.py -- --icon payout --out out/payout.png --size 512 --samples 96
```

The film is 216 frames of story and a 96-frame loop at 24 fps. A run skips frames it has already rendered, so an interrupted render picks up where it stopped.
