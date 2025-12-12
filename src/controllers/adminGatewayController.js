import prisma from '../prisma.js';

// GET: Fetch current config (Hide Secret Key)
export const getGatewayConfig = async (req, res) => {
  try {
    const { clinicId } = req.user;

    const gateway = await prisma.paymentGateway.findFirst({
      where: { 
        clinicId, 
        name: 'STRIPE',
        deletedAt: null
      },
      select: { 
        apiKey: true,   // Send Public Key
        isActive: true  // Send Status
        // NEVER send 'secret' back to frontend
      } 
    });

    // Return empty if not found, rather than 404
    res.json(gateway || { apiKey: '', isActive: false });
  } catch (error) {
    console.error("Get Gateway Error:", error);
    res.status(500).json({ error: error.message });
  }
};

// POST: Update or Create Configuration
export const updateGatewayConfig = async (req, res) => {
  try {
    const { clinicId } = req.user;
    const { publishableKey, secretKey, isActive } = req.body;

    if (!publishableKey) {
      return res.status(400).json({ error: 'Publishable Key is required' });
    }

    // Logic: Only update secretKey if user provided a new one. 
    // If it's empty string, keep the old one (assuming they are just toggling active status).
    const updateData = {
      apiKey: publishableKey,
      isActive: isActive,
      deletedAt: null
    };

    if (secretKey && secretKey.trim() !== '') {
      updateData.secret = secretKey;
    }

    const gateway = await prisma.paymentGateway.upsert({
      where: {
        clinicId_name: {
          clinicId,
          name: 'STRIPE'
        }
      },
      update: updateData,
      create: {
        clinicId,
        name: 'STRIPE',
        apiKey: publishableKey,
        secret: secretKey, // Required on creation
        isActive: isActive
      }
    });

    res.json({ message: 'Payment settings updated successfully', gateway });
  } catch (error) {
    console.error('Update Gateway Error:', error);
    res.status(500).json({ error: error.message });
  }
};
