# Projection mapping demo

Three plain HTML pages (vanilla JavaScript, no build step, no dependencies) that
talk to each other over the
[BroadcastChannel API](https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel)
to demonstrate projection mapping with two homographies.

| Page | Script | What it does |
| --- | --- | --- |
| `index.html` | `geometry.js` | **True geometry.** Draw named, coloured polygons on a 2D plan or elevation, and place the four reference points A–D. |
| `projector.html` | `projector.js` | **Projector.** Warps all the geometry with one homography. Drag A–D to where those points should land in the projected image. |
| `camera.html` | `camera.js` | **Camera.** Starts a webcam. Drag A–D to where those points appear in the camera image; a second homography overlays the polygons on the video and maps detected points back into the true geometry. |

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
   the yellow reference points A–D onto four features you can identify in the
   real space (for example the corners of a table or wall).
2. **Projector** — drag A–D until each projected marker sits on its real
   reference point. <kbd>G</kbd> toggles the alignment grid, <kbd>H</kbd> hides
   the handles and controls, <kbd>R</kbd> resets the corners.
3. **Camera** — start the webcam and drag A–D onto the same four features as
   the camera sees them. The polygons are drawn over the video. Hover the
   image, or pick a detection mode (brightest spot or motion), and the detected
   point is converted to true-geometry coordinates and sent to the other two
   pages, which mark it and highlight any polygon it falls inside.

## How it works

A homography is a 3×3 matrix that maps one plane onto another as seen in
perspective. Four point pairs determine it exactly (`PM.solveHomography` in
`shared.js` solves the resulting 8×8 linear system).

- Projector: `H_p` maps true geometry → projector pixels, from A–D ↔ the four
  projector handles.
- Camera: `H_c` maps true geometry → camera image, from A–D ↔ the four camera
  handles. Its inverse maps camera detections → true geometry.

Straight lines stay straight under a homography, so warping a polygon only
requires transforming its vertices.

Messages on the channel are `{ topic, data }`. Each topic has one owning page:
`geometry` (polygons and reference points), `projector` and `camera` (their
handle positions) and `detections`. State is also kept in `localStorage`, and a
newly opened page sends `hello` so the others re-broadcast what they own.
