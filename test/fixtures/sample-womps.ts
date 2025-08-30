import type { Womp } from '../../src/index';

// Sample womp data for testing, based on real API structure
export const mockApiResponse = {
  success: true,
  womps: [
    {
      id: 80_643,
      author: '0x889b4449ade3766937eac2e3801d65f555857c8b',
      content: 'nice',
      parcel_id: 1776,
      image_url:
        'https://media.crvox.com/womps/0x889b4449ade3766937eac2e3801d65f555857c8b/womp_1756493620823_f182f4900c46e552003bf8e6663ebb3d.jpg',
      coords: 'E@247W,337N,5.5U',
      created_at: '2025-08-29T18:53:42.645Z',
      updated_at: '2025-08-29T18:53:42.645Z',
      image_supplied: false,
      parcel_name: 'PIGGYBANK',
      parcel_address: '26 Boots Crossing',
      parcel_island: 'Origin City',
      author_name: null,
    },
    {
      id: 80_642,
      author: '0x889b4449ade3766937eac2e3801d65f555857c8b',
      content: 'Pig Station elements',
      parcel_id: 1722,
      image_url:
        'https://media.crvox.com/womps/0x889b4449ade3766937eac2e3801d65f555857c8b/womp_1756493561826_a916706148165151ecf60984c1e5fb40.jpg',
      coords: 'SW@233W,343N,1U',
      created_at: '2025-08-29T18:52:43.808Z',
      updated_at: '2025-08-29T18:52:43.808Z',
      image_supplied: false,
      parcel_name: null,
      parcel_address: '25 Boots Crossing',
      parcel_island: 'Origin City',
      author_name: null,
    },
    {
      id: 80_634,
      author: '0x158eFD533f5fae7933c334E8e9cDC1026A7A95A2',
      content: '<3',
      parcel_id: 2071,
      image_url:
        'https://media.crvox.com/womps/0x158efd533f5fae7933c334e8e9cdc1026a7a95a2/womp_1756425054166_8aa2944c3baa5943cfb426d6e29f51e6.jpg',
      coords: 'S@75E,433S',
      created_at: '2025-08-28T23:50:55.693Z',
      updated_at: '2025-08-28T23:50:55.693Z',
      image_supplied: false,
      parcel_name: 'DIE GORGEOUS',
      parcel_address: '15 Rand Extension',
      parcel_island: 'Origin City',
      author_name: 'AdoraTokyo',
    },
  ],
};

export const mockProcessedWomps: Womp[] = [
  {
    id: 80_643,
    content: 'nice',
    location: 'PIGGYBANK',
    author: '0x889b44...57c8b',
    playUrl: 'https://voxels.com/play?coords=E@247W,337N,5.5U',
    imgSrc:
      'https://media.crvox.com/womps/0x889b4449ade3766937eac2e3801d65f555857c8b/womp_1756493620823_f182f4900c46e552003bf8e6663ebb3d.jpg',
  },
  {
    id: 80_642,
    content: 'Pig Station elements',
    location: '25 Boots Crossing',
    author: '0x889b44...57c8b',
    playUrl: 'https://voxels.com/play?coords=SW@233W,343N,1U',
    imgSrc:
      'https://media.crvox.com/womps/0x889b4449ade3766937eac2e3801d65f555857c8b/womp_1756493561826_a916706148165151ecf60984c1e5fb40.jpg',
  },
  {
    id: 80_634,
    content: '<3',
    location: 'DIE GORGEOUS',
    author: 'AdoraTokyo',
    playUrl: 'https://voxels.com/play?coords=S@75E,433S',
    imgSrc:
      'https://media.crvox.com/womps/0x158efd533f5fae7933c334e8e9cdc1026a7a95a2/womp_1756425054166_8aa2944c3baa5943cfb426d6e29f51e6.jpg',
  },
];
