'use strict';

const CITIES = {
  bengaluru: {
    key: 'bengaluru',
    name: 'Bengaluru',
    // south, west, north, east — Central Bengaluru / Koramangala / Indiranagar
    bbox: [12.885, 77.525, 13.045, 77.69],
    center: [12.965, 77.6],
    hospitals: [
      { name: 'St. John\'s Medical College Hospital', lat: 12.9299, lng: 77.6190 },
      { name: 'Manipal Hospital, Old Airport Rd', lat: 12.9590, lng: 77.6485 },
      { name: 'Bowring & Lady Curzon Hospital', lat: 12.9829, lng: 77.6045 },
      { name: 'Victoria Hospital', lat: 12.9636, lng: 77.5765 },
      { name: 'Sakra / Koramangala Clinic', lat: 12.9352, lng: 77.6416 },
    ],
  },
  mumbai: {
    key: 'mumbai',
    name: 'Mumbai',
    bbox: [19.0, 72.81, 19.07, 72.88],
    center: [19.035, 72.845],
    hospitals: [
      { name: 'Lilavati Hospital', lat: 19.0510, lng: 72.8290 },
      { name: 'Hinduja Hospital', lat: 19.0337, lng: 72.8384 },
      { name: 'KEM Hospital', lat: 19.0024, lng: 72.8424 },
      { name: 'Sion Hospital', lat: 19.0337, lng: 72.8606 },
    ],
  },
  delhi: {
    key: 'delhi',
    name: 'New Delhi',
    bbox: [28.56, 77.17, 28.64, 77.25],
    center: [28.6, 77.21],
    hospitals: [
      { name: 'AIIMS New Delhi', lat: 28.5672, lng: 77.2100 },
      { name: 'Safdarjung Hospital', lat: 28.5686, lng: 77.2054 },
      { name: 'Ram Manohar Lohia Hospital', lat: 28.6260, lng: 77.2005 },
      { name: 'Lok Nayak Hospital', lat: 28.6390, lng: 77.2370 },
    ],
  },
};

module.exports = {
  PORT: Number(process.env.PORT) || 3000,
  CITY: CITIES[(process.env.CITY || 'bengaluru').toLowerCase()] || CITIES.bengaluru,
  OFFLINE: process.env.OFFLINE === '1',
  FLEET_SIZE: Number(process.env.FLEET_SIZE) || 14,
  SIM_SPEED: Number(process.env.SIM_SPEED) || 8, // simulated seconds per real second
  TICK_MS: 500,
  ON_SCENE_SECONDS: 240,
  HANDOVER_SECONDS: 180,
  CITIES,
};
