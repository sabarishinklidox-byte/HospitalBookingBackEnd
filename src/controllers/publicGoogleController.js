// GET /api/public/google/place-id?query=...
import axios from 'axios';

export async function getPlaceIdFromText(req, res) {
  try {
    const { query } = req.query;
    if (!query) {
      return res.status(400).json({
        error:
          'Please type clinic name + city + area exactly as on Google Maps.',
      });
    }

    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    const url =
      'https://maps.googleapis.com/maps/api/place/findplacefromtext/json';

    const { data } = await axios.get(url, {
      params: {
        input: query,
        inputtype: 'textquery',
        fields: 'place_id,name,formatted_address',
        key: apiKey,
      },
    });

    if (!data.candidates || data.candidates.length === 0) {
      return res.status(404).json({
        error:
          'Clinic not found. Please copy the exact name + address from Google Maps.',
      });
    }

    const norm = (s) =>
      (s || '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();

    const q = norm(query);

    // pick best candidate from Google
    const best = data.candidates[0];
    const name = norm(best.name); // e.g. "ganga hospital"
    const addr = norm(best.formatted_address); // e.g. "313, mettupalayam rd, saibaba colony, coimbatore..."

    // Extract first line parts from address (road + area + city)
    const [addrLine] = addr.split(',');
    const mustContain = [
      name.split(' ')[0], // first word of name: "ganga"
      addrLine.split(' ')[0], // first token of address line: "313" or "mettupalayam"
    ];

    // Rule: every mustContain token must appear in what the user typed
    const allMatch = mustContain.every((token) => q.includes(token));

    if (!allMatch) {
      return res.status(404).json({
        error:
          'Could not confidently match this clinic. Please paste the full clinic name + address from Google Maps.',
      });
    }

    return res.json({
      placeId: best.place_id,
      name: best.name,
      address: best.formatted_address,
    });
  } catch (err) {
    console.error(
      'Google place lookup failed',
      err.response?.data || err.message
    );
    return res.status(500).json({ error: 'Failed to lookup place.' });
  }
}
