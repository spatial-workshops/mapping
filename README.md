# Projection mapping demo

Three plain HTML pages (vanilla JavaScript, no build step, no dependencies) that
talk to each other over the
[BroadcastChannel API](https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel)
to demonstrate projection mapping with homographies.

A **mapping set** is one surface in the real space: four reference points A–D
with three representations (in the true geometry, on the projector and in the
camera image) and the two homographies that relate them. You can create any
number of mapping sets, and every polygon belongs to one, so objects drawn in
the same true geometry can be projected onto different surfaces and still be
found from the camera.

| Page | Script | What it does |
| --- | --- | --- |
| `index.html` | `geometry.js` | **True geometry.** Draw named, coloured polygons on a 2D plan or elevation, create mapping sets, and place each set's reference points A–D. |
| `projector.html` | `projector.js` | **Projector.** Warps each set's polygons with that set's homography. Drag a set's A–D to where those points should land in the projected image. |
| `camera.html` | `camera.js` | **Camera.** Starts a webcam. Drag a set's A–D to where those points appear in the camera image; the set's second homography overlays its polygons on the video and maps detected points back into the true geometry. |

`shared.js` holds what all three need: the channel, saved state, and the
homography maths. `style.css` is the shared styling.

## Running it

The webcam and BroadcastChannel both need the pages to share an `http://`
origin, so serve the folder rather than opening the files directly:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000/> and use the links at the top to open the
projector and camera pages in their own windows. Put the projector window on
the projector and press <kbd>F</kbd> for fullscreen.

## Using it

1. **Geometry** — with *Draw*, click to add corners; click the first corner,
   double-click or press Enter to close the polygon, then type its name. With
   *Edit*, select, move, reshape, recolour, rename or delete polygons, and drag
   a set's reference points A–D onto four features you can identify on the
   real surface (for example the corners of a table or wall).
2. **Mapping sets** — under *Mapping sets*, *Add set* creates another surface
   with its own A–D (each set has its own handle colour). New polygons join
   the active set; the dropdown under a selected polygon's name moves it to
   another set. The active set is shared by all three pages, and grabbing any
   set's handle on any page makes that set active.
3. **Projector** — for each set, drag A–D until each projected marker sits on
   its real reference point. <kbd>G</kbd> toggles the active set's alignment
   grid, <kbd>H</kbd> hides the handles and controls, <kbd>R</kbd> resets the
   active set's corners.
4. **Camera** — start the webcam and, for each set, drag A–D onto the same
   four features as the camera sees them. The polygons are drawn over the
   video. Hover the image, or pick a detection mode (brightest spot or
   motion), and the detected point is converted to true-geometry coordinates
   and sent to the other two pages, which mark it and highlight any polygon it
   falls inside.

## How it works

A homography is a 3×3 matrix that maps one plane onto another as seen in
perspective. Four point pairs determine it exactly (`PM.solveHomography` in
`shared.js` solves the resulting 8×8 linear system).

Each mapping set has its own pair:

- Projector: `H_p` maps true geometry → projector pixels, from the set's A–D ↔
  its four projector handles.
- Camera: `H_c` maps true geometry → camera image, from the set's A–D ↔ its
  four camera handles. Its inverse maps camera detections → true geometry.

A point detected in the camera is tried against every set's inverse `H_c`. It
is attributed to the sets where it lands inside one of that set's polygons;
failing that, to the sets whose A–D outline contains it in the camera image;
failing that, to the active set.

Straight lines stay straight under a homography, so warping a polygon only
requires transforming its vertices.

Messages on the channel are `{ topic, data }`. Each topic has one owning page:
`geometry` (polygons and mapping sets with their reference points),
`projector` and `camera` (handle positions per set), `detections` and
`active` (the set being edited). State is also kept in `localStorage`, and a
newly opened page sends `hello` so the others re-broadcast what they own.
