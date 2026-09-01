// Landmark styling + card, from OSM tourism / historic / amenity tags. Pure.

export function landmarkCategory(tags) {
  return tags.tourism || tags.historic || tags.amenity || 'feature';
}

export function describeLandmark(n) {
  const tags = n.meta.tags;
  const category = landmarkCategory(tags);
  return {
    id: n.id,
    title: tags.name || category,
    subtitle: tags.name ? category : 'unnamed',
    rows: [
      ['Category', category],
      ['Type', tags.tourism || tags.historic || tags.amenity || '—'],
      [
        'Coordinates',
        `${n.position.latitude.toFixed(4)}, ${n.position.longitude.toFixed(4)}`,
      ],
    ],
  };
}
