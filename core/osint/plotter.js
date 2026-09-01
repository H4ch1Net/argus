import * as Cesium from 'cesium';

// Plots OSINT query-console results as labelled markers on their own data source.
// These are query OUTPUTS, not a toggleable feed layer, so they live outside the
// layer manager; the interaction spine resolves them by consulting this plotter's
// getRecord alongside the active layers (an extra resolver). Markers persist for
// the session so a queried asset stays on the globe and stays clickable.

export function createOsintPlotter(viewer) {
  const ds = new Cesium.CustomDataSource('osint');
  viewer.dataSources.add(ds);
  const records = new Map();

  return {
    id: 'osint',
    /** @returns {Cesium.Entity} the plotted marker (for tracking) */
    plot(result) {
      const { longitude, latitude } = result.position;
      const carto = Cesium.Cartesian3.fromDegrees(longitude, latitude, 0);
      // Correlated (multi-source) results get a warmer, larger marker so they
      // read as distinct from a plain single-source query plot.
      const correlated = result.variant === 'correlated';
      let rec = records.get(result.id);
      if (!rec) {
        const entity = ds.entities.add({
          id: result.id,
          position: carto,
          point: new Cesium.PointGraphics({
            pixelSize: correlated ? 15 : 12,
            color: Cesium.Color.fromCssColorString(correlated ? '#ffcc55' : '#00e5ff'),
            outlineColor: Cesium.Color.fromCssColorString('#03121a').withAlpha(0.85),
            outlineWidth: correlated ? 3 : 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          }),
          label: new Cesium.LabelGraphics({
            text: result.value,
            font: '12px monospace',
            fillColor: Cesium.Color.fromCssColorString('#9fe8ff'),
            showBackground: true,
            backgroundColor: Cesium.Color.fromCssColorString('#03121a').withAlpha(0.82),
            pixelOffset: new Cesium.Cartesian2(0, -18),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            scale: 0.9,
          }),
        });
        rec = { entity, result };
        records.set(result.id, rec);
      } else {
        rec.entity.position = carto;
        rec.result = result;
      }
      viewer.scene.requestRender();
      return rec.entity;
    },
    // Extra resolver for the interaction spine (same shape as a layer getRecord).
    getRecord(id) {
      const rec = records.get(id);
      if (!rec) return null;
      return {
        entity: rec.entity,
        cardModel: rec.result.card,
        mover: false,
        getHistoryFixes: () => [],
      };
    },
    clear() {
      ds.entities.removeAll();
      records.clear();
      viewer.scene.requestRender();
    },
  };
}
