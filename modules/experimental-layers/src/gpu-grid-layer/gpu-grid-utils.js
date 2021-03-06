// Copyright (c) 2015 - 2017 Uber Technologies, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

const R_EARTH = 6378000;

import {Matrix4} from 'math.gl';
import {fp64 as fp64Utils} from 'luma.gl';
const {fp64LowPart} = fp64Utils;

/**
 * Calculate density grid from an array of points
 * @param {array} points
 * @param {function} getPosition - position accessor
 * @param {number} cellSizeMeters - cell size in meters
 * @param {object} gpuGridAggregator - gpu aggregator
 * @param {bool} gpuAggregation - flag to enable gpu aggregation
 * @returns {object} - grid data, cell dimension
 */
export function pointToDensityGridData({
  data,
  getPosition,
  cellSizeMeters,
  gpuGridAggregator,
  gpuAggregation,
  fp64 = false
}) {
  const gridData = _parseData(data, getPosition);
  const gridOffset = _getGridOffset(gridData, cellSizeMeters);

  const opts = _getGPUAggregationParams(gridData, gridOffset);

  const aggregatedData = gpuGridAggregator.run({
    positions: opts.positions,
    positions64xyLow: opts.positions64xyLow,
    weights: opts.weights,
    cellSize: opts.cellSize,
    width: opts.width,
    height: opts.height,
    gridTransformMatrix: opts.gridTransformMatrix,
    useGPU: gpuAggregation,
    fp64
  });

  const gridSizeX = Math.ceil(opts.width / opts.cellSize[0]);
  const gridSizeY = Math.ceil(opts.height / opts.cellSize[1]);

  return {
    countsBuffer: aggregatedData.countsBuffer,
    maxCountBuffer: aggregatedData.maxCountBuffer,
    gridSize: [gridSizeX, gridSizeY],
    gridOrigin: opts.gridOrigin,
    gridOffset: [opts.gridOffset.xOffset, opts.gridOffset.yOffset]
  };
}

// Aligns `inValue` to given `cellSize`
export function alignToCellBoundary(inValue, cellSize) {
  const sign = inValue < 0 ? -1 : 1;

  let value = sign < 0 ? Math.abs(inValue) + cellSize : Math.abs(inValue);

  value = Math.floor(value / cellSize) * cellSize;

  return value * sign;
}

// Calculate grid parameters
function _getGPUAggregationParams(gridData, gridOffset) {
  const {latMin, latMax, lngMin, lngMax, positions, positions64xyLow, weights} = gridData;

  // NOTE: this alignment will match grid cell boundaries with existing CPU implementation
  // this gurantees identical aggregation results between current and new layer.
  // We align the origin to cellSize in positive space lng:[0 360], lat:[0 180]
  // After alignment we move it back to original range
  // Origin = [minX, minY]
  // Origin = Origin + [180, 90] // moving to +ve space
  // Origin = Align(Origin, cellSize) //Align to cell boundary
  // Origin = Origin - [180, 90]
  const originY = alignToCellBoundary(latMin + 90, gridOffset.yOffset) - 90;
  const originX = alignToCellBoundary(lngMin + 180, gridOffset.xOffset) - 180;

  // Setup transformation matrix so that every point is in +ve range
  const gridTransformMatrix = new Matrix4().translate([-1 * originX, -1 * originY, 0]);

  const cellSize = [gridOffset.xOffset, gridOffset.yOffset];
  const gridOrigin = [originX, originY];
  const width = lngMax - lngMin + gridOffset.xOffset;
  const height = latMax - latMin + gridOffset.yOffset;

  return {
    positions,
    positions64xyLow,
    weights,
    cellSize,
    gridOrigin,
    width,
    height,
    gridTransformMatrix,
    gridOffset
  };
}

/**
 * Based on geometric center of sample points, calculate cellSize in lng/lat (degree) space
 * @param {array} points
 * @param {number} cellSize - unit size in meters
 * @param {function} getPosition - position accessor
 * @returns {yOffset, xOffset} - cellSize size lng/lat (degree) space.
 */

function _getGridOffset(gridData, cellSize) {
  const {latMin, latMax} = gridData;

  const centerLat = (latMin + latMax) / 2;

  return _calculateGridLatLonOffset(cellSize, centerLat);
}

/**
 * calculate grid layer cell size in lat lon based on world unit size
 * and current latitude
 * @param {number} cellSize
 * @param {number} latitude
 * @returns {object} - lat delta and lon delta
 */
function _calculateGridLatLonOffset(cellSize, latitude) {
  const yOffset = _calculateLatOffset(cellSize);
  const xOffset = _calculateLonOffset(latitude, cellSize);
  return {yOffset, xOffset};
}

/**
 * with a given x-km change, calculate the increment of latitude
 * based on stackoverflow http://stackoverflow.com/questions/7477003
 * @param {number} dy - change in km
 * @return {number} - increment in latitude
 */
function _calculateLatOffset(dy) {
  return (dy / R_EARTH) * (180 / Math.PI);
}

/**
 * with a given x-km change, and current latitude
 * calculate the increment of longitude
 * based on stackoverflow http://stackoverflow.com/questions/7477003
 * @param {number} lat - latitude of current location (based on city)
 * @param {number} dx - change in km
 * @return {number} - increment in longitude
 */
function _calculateLonOffset(lat, dx) {
  return ((dx / R_EARTH) * (180 / Math.PI)) / Math.cos((lat * Math.PI) / 180);
}

// Parse input data to build positions and boundaries.
function _parseData(data, getPosition) {
  const positions = [];
  const positions64xyLow = [];
  const weights = [];

  let latMin = Infinity;
  let latMax = -Infinity;
  let lngMin = Infinity;
  let lngMax = -Infinity;
  let pLat;
  let pLng;
  for (let p = 0; p < data.length; p++) {
    pLng = getPosition(data[p])[0];
    pLat = getPosition(data[p])[1];

    positions.push(pLng, pLat);
    positions64xyLow.push(fp64LowPart(pLng), fp64LowPart(pLat));
    weights.push(1.0);

    if (Number.isFinite(pLat) && Number.isFinite(pLng)) {
      latMin = pLat < latMin ? pLat : latMin;
      latMax = pLat > latMax ? pLat : latMax;

      lngMin = pLng < lngMin ? pLng : lngMin;
      lngMax = pLng > lngMax ? pLng : lngMax;
    }
  }

  return {
    positions,
    positions64xyLow,
    weights,
    latMin,
    latMax,
    lngMin,
    lngMax
  };
}
