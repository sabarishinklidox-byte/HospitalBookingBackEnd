import prisma from '../prisma.js';

// GET: Fetch configuration for a specific gateway
// GET /api/admin/payment-settings?gateway=STRIPE|RAZORPAY
export const getGatewayConfig = async (req, res) => {
  try {
    const { clinicId } = req.user;

    const gatewayName = (req.query.gateway || 'STRIPE').toUpperCase();

    if (!['STRIPE', 'RAZORPAY'].includes(gatewayName)) {
      return res.json({ apiKey: '', isActive: false });
    }

    const gateway = await prisma.paymentGateway.findFirst({
      where: {
        clinicId,
        name: gatewayName,
        deletedAt: null,
      },
      select: {
        apiKey: true,   // public key (Stripe PK or Razorpay Key ID)
        isActive: true, // status
      },
    });

    res.json(gateway || { apiKey: '', isActive: false });
  } catch (error) {
    console.error('Get Gateway Error:', error);
    res.status(500).json({ error: error.message });
  }
};

// GET: which gateway is currently active for this clinic
// GET /api/admin/payment-settings/active
export const getActiveGatewayForClinic = async (req, res) => {
  try {
    const { clinicId } = req.user;

    const gw = await prisma.paymentGateway.findFirst({
      where: {
        clinicId,
        isActive: true,
        deletedAt: null,
      },
      select: {
        name: true,
      },
    });

    res.json({ activeGateway: gw?.name || 'STRIPE' });
  } catch (error) {
    console.error('Get Active Gateway Error:', error);
    res.status(500).json({ error: error.message });
  }
};

// POST: Update or Create Configuration for a specific gateway
// POST /api/admin/payment-settings
// Body: { gatewayName: 'RAZORPAY', publishableKey: '...', secretKey: '...', isActive: true }
export const updateGatewayConfig = async (req, res) => {
  try {
    const { clinicId } = req.user;
    const { gatewayName, publishableKey, secretKey, isActive } = req.body;

    const name = (gatewayName || 'STRIPE').toUpperCase();
    if (!['STRIPE', 'RAZORPAY'].includes(name)) {
      return res
        .status(400)
        .json({ error: 'Invalid gateway name. Use STRIPE or RAZORPAY.' });
    }

    if (!publishableKey) {
      return res.status(400).json({
        error:
          name === 'RAZORPAY'
            ? 'Key ID is required'
            : 'Publishable Key is required',
      });
    }

    const updateData = {
      apiKey: publishableKey,
      deletedAt: null,
    };

    if (typeof isActive === 'boolean') {
      updateData.isActive = isActive;
    }

    if (secretKey && secretKey.trim() !== '') {
      updateData.secret = secretKey;
    }

    const gateway = await prisma.paymentGateway.upsert({
      where: {
        clinicId_name: {
          clinicId,
          name,
        },
      },
      update: updateData,
      create: {
        clinicId,
        name,
        apiKey: publishableKey,
        secret: secretKey || '',
        isActive: typeof isActive === 'boolean' ? isActive : true,
      },
    });

    // if this one is active, deactivate all others for this clinic
    if (gateway.isActive) {
      await prisma.paymentGateway.updateMany({
        where: {
          clinicId,
          NOT: { id: gateway.id },
        },
        data: { isActive: false },
      });
    }

    res.json({ message: `${name} settings updated successfully`, gateway });
  } catch (error) {
    console.error('Update Gateway Error:', error);
    res.status(500).json({ error: error.message });
  }
};
