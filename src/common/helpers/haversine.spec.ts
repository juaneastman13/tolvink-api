import { haversineDistance, haversineDistanceOrNull } from './haversine';

describe('haversineDistance', () => {
  it('Montevideo → Buenos Aires ≈ 200 km', () => {
    const d = haversineDistance(-34.9011, -56.1645, -34.6037, -58.3816);
    expect(d).toBeGreaterThan(190);
    expect(d).toBeLessThan(220);
  });

  it('same point → 0', () => {
    expect(haversineDistance(-34.9, -56.16, -34.9, -56.16)).toBe(0);
  });

  it('Montevideo → São Paulo ≈ 1550-1600 km', () => {
    const d = haversineDistance(-34.9011, -56.1645, -23.5505, -46.6333);
    expect(d).toBeGreaterThan(1500);
    expect(d).toBeLessThan(1650);
  });
});

describe('haversineDistanceOrNull', () => {
  it('returns null if any coord is null', () => {
    expect(haversineDistanceOrNull(null, -56, -34, -58)).toBeNull();
    expect(haversineDistanceOrNull(-34, null, -34, -58)).toBeNull();
    expect(haversineDistanceOrNull(-34, -56, null, -58)).toBeNull();
    expect(haversineDistanceOrNull(-34, -56, -34, null)).toBeNull();
  });

  it('returns null if any coord is undefined', () => {
    expect(haversineDistanceOrNull(undefined, -56, -34, -58)).toBeNull();
  });

  it('returns null if any coord is NaN', () => {
    expect(haversineDistanceOrNull(NaN, -56, -34, -58)).toBeNull();
    expect(haversineDistanceOrNull(-34, NaN, -34, -58)).toBeNull();
  });

  it('returns distance when all coords present', () => {
    const d = haversineDistanceOrNull(-34.9011, -56.1645, -34.6037, -58.3816);
    expect(d).not.toBeNull();
    expect(d!).toBeGreaterThan(190);
  });
});
