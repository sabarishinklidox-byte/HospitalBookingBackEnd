import prisma from '../prisma.js';
import axios from 'axios';
export const refreshClinicGoogleRating = async (req, res) => {
  try {
    const { clinicId } = req.user;

    const clinic = await prisma.clinic.findUnique({
      where: { id: clinicId },
    });

    console.log('Clinic ID:', clinicId);
    console.log('Clinic name:', clinic?.name);
    console.log('Stored googlePlaceId:', clinic?.googlePlaceId);

    if (!clinic || !clinic.googlePlaceId) {
      return res
        .status(400)
        .json({ error: 'Clinic or Google Place ID not configured.' });
    }

    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    const url = 'https://maps.googleapis.com/maps/api/place/details/json';

    const { data } = await axios.get(url, {
      params: {
        place_id: clinic.googlePlaceId,
        fields: 'rating,user_ratings_total',
        key: apiKey,
      },
    });

    console.log('Google status:', data.status);
    console.log('Google response:', data);

    if (data.status !== 'OK') {
      return res
        .status(400)
        .json({ error: `Google Places error: ${data.status}` });
    }

    const rating = data.result?.rating ?? null;
    const totalReviews = data.result?.user_ratings_total ?? null;

    const updated = await prisma.clinic.update({
      where: { id: clinicId },
      data: {
        googleRating: rating,
        googleTotalReviews: totalReviews,
        lastGoogleSync: new Date(),
      },
      select: {
        id: true,
        name: true,
        googleRating: true,
        googleTotalReviews: true,
        lastGoogleSync: true,
      },
    });

    return res.json({ clinic: updated });
  } catch (err) {
    console.error('Refresh Google rating error:', err.response?.data || err);
    return res
      .status(500)
      .json({ error: 'Failed to refresh rating from Google.' });
  }
};
