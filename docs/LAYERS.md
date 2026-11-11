# Several layers on one map

(2026-11-09)

Someone comparing geospatial layers needs them stacked on one map, each with
its own colours, opacity and place in the order. There are two ways to get
there, and neither replaces the other.

## 1. Asking for it: the planner returns several layers

"Show median household income and hospitals on the same map", "overlay
transmission lines on population density", "obesity and the uninsured rate as
layers".

The compiler and executor have returned one layer per `output` step since the
plan became a DAG. The prompt still said "End with exactly one output". So a
question asking for two things on one map got one.

- **Gate.** `LAYER_PHRASES` in `planner/conditions.js` matches explicit layering
  phrasing only: "on the same / one map", "overlay", "layers", "on top".
  "Poverty and unemployment" alone is still a join or a comparison.
- **What the gate turns on.**
  - The closing rule becomes "one output for EACH layer".
  - A `LAYERS_NOTE` with a worked example (a choropleth plus a `select_features`
    layer) is added.
  - `select_features` is offered, because a layer of facilities is their
    locations.
- **Blast radius: 0 of 121 questions** in the other eval suites. The 48-context
  snapshot is byte-identical.

**Measured**, `eval/layers.yaml` (5 overlay questions plus a single-layer control),
`plan_probe.py` 3x (`eval/layers/`):

| run | result |
|---|---|
| 1 | **6 / 6** |
| 2 | 5 / 5 answered |
| 3 | 4 / 4 answered |

Run 2's control and run 3's first question failed with "Remote end closed
connection": my own web-container rebuild restarted the proxy mid-request.
Run 3's Ohio question timed out in the queue behind the request that was cut
off. Re-run on its own it took 43 s, and returned 88 Ohio counties plus 1,824
fire stations as two layers. **Every answered overlay question produced ≥ 2
layers, and the control stayed at 1.**

## 2. Building it: "Add layer"

The stage map has an **Add layer** button: in the toolbar of a single-layer
map, and in the layer panel once there are several. It offers:

- **This conversation:** earlier answers in the thread, and the other steps of
  a multi-step analysis, which are already computed.
- **Catalog:** any county measure or facility dataset with data loaded, mapped
  through the existing `map_measure` edit (`/api/analyze/revise`). No planner
  call; under a second.

Added layers are kept PER ANSWER. Going back to an earlier answer brings its
stack back.

## The layer stack (`components/LayerStack.tsx`)

A result goes to the stack when it has more than one layer (several outputs, or
the two measures of a join, `lib/layers.ts`) or when anything was added. A
single layer keeps the full single-measure map.

Per layer:

- **Visibility and opacity.** A county a fill has no value for is TRANSPARENT,
  not grey, so the layers beneath show through.
- **Colour.** A ramp for fills, a colour for points and lines. A new layer
  takes the first one not already in use.
- **Classification and legend.** Natural breaks, quantile or equal interval,
  with the layer's own legend. A diverging measure keeps its symmetric bins.
- **Order.** Drag, or the arrows. Each layer draws in its own Leaflet pane and
  the order is the pane's z-index, so reordering never rebuilds polygons.
  Points and lines start above fills.
- **Removal.** Added layers only; the answer's own layers stay.

The hover readout lists every visible fill's value for the county under the
pointer.

## Natural breaks (`lib/classify.ts`)

Fisher-Jenks by dynamic programming over prefix sums. Above 1,200 values it runs
on an evenly spaced sample of the sorted values, as desktop GIS does.

Verified:

- equal to a brute-force search over every 3-class split of 60 values;
- [1,2,3,10,11,12,20,21,22] into 3 classes gives breaks [3, 12];
- 19 ms for 3,233 values in 6 classes.

It is the default for new maps, single or stacked. The choice is a per-map menu
and is remembered.

## The multi-step strip

Collapses to a pill showing the chain in miniature (1 → 2) and its status. The
choice is remembered, and the map's fit and legend follow the height.

## Known limits

- **Facility layers are capped at `MAX_FEATURES` (3,000).** Hospitals and Fire
  Stations both stop at 3,000, and the layer does not say it is truncated.
- **Hand-added catalog layers ignore the answer's area restriction.** A
  catalog layer is national; "only Texas" is not carried over to it.
- **Stack fit can include Alaska.** The stack frames the answer's own layers,
  and a national answer includes Alaska, so it opens zoomed out.
- **The phone layout has not been checked by eye.**
