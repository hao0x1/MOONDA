import { Ellipsoid } from 'cesium';

// The Moon as a sphere of radius 1,737.4 km (the reference used by NASA LOLA and Moon Trek).
export const MOON_ELLIPSOID = Ellipsoid.MOON;
Ellipsoid.default = Ellipsoid.MOON;
