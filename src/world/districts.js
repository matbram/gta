// District definitions for Bayvale — an original city.
// Each district drives street density, architecture, props, ground paint and map colour.

export const DISTRICTS = {
  crown: {
    name: 'Crown Center',
    roadDensity: 1.0,
    mapColor: '#b8b0a4', groundStyle: 'city',
    ambience: 'downtown',
  },
  oldtown: {
    name: 'Old Coronet',
    roadDensity: 1.0,
    mapColor: '#c2b49e', groundStyle: 'city',
    ambience: 'commercial',
  },
  midtown: {
    name: 'Midtown',
    roadDensity: 0.9,
    mapColor: '#bdb2a2', groundStyle: 'city',
    ambience: 'commercial',
  },
  suburbs: {
    name: 'Sunset Flats',
    roadDensity: 0.72,
    mapColor: '#c8bfa8', groundStyle: 'suburb',
    ambience: 'residential',
  },
  docks: {
    name: 'Ironhook Docks',
    roadDensity: 0.55,
    mapColor: '#a8a29a', groundStyle: 'industrial',
    ambience: 'industrial',
  },
  beach: {
    name: 'Verdemar Beach',
    roadDensity: 0.5,
    mapColor: '#e0d2ac', groundStyle: 'beach',
    ambience: 'beach',
  },
  park: {
    name: 'Palmera Park',
    roadDensity: 0.0,
    mapColor: '#8fae74', groundStyle: 'park',
    ambience: 'park',
  },
  heights: {
    name: 'Bayvale Heights',
    roadDensity: 0.4,
    mapColor: '#a9b18e', groundStyle: 'hills',
    ambience: 'hills',
  },
  farm: {
    name: 'Northfields',
    roadDensity: 0.3,
    mapColor: '#b9b283', groundStyle: 'farm',
    ambience: 'country',
  },
  bay: {
    name: 'Bayvale Bay',
    roadDensity: 0,
    mapColor: '#4a7a96', groundStyle: 'water',
    ambience: 'water',
  },
};

export function districtName(key) {
  return DISTRICTS[key] ? DISTRICTS[key].name : '';
}
