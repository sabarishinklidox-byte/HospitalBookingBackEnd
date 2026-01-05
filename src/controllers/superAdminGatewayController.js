// controllers/superAdminGatewayController.js
import prisma from '../prisma.js';

export const getSuperAdminGateway = async (req, res) => {
  try {
    const gateway = await prisma.superAdminPaymentGateway.findFirst({
      where: { name: 'RAZORPAY', isActive: true },
    });
    
    res.json({
      configured: !!gateway,
      gateway: gateway ? {
        id: gateway.id,
        apiKey: gateway.apiKey,
        secretMasked: '••••••••',
        isActive: gateway.isActive,
        mode: gateway.mode,
      } : null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const upsertSuperAdminGateway = async (req, res) => {
  try {
    const { apiKey, secret, webhookSecret, isActive, mode = 'TEST' } = req.body;
    
    const gateway = await prisma.superAdminPaymentGateway.upsert({
      where: { name: 'RAZORPAY' },
      update: { apiKey, secret, webhookSecret, isActive, mode },
      create: { 
        name: 'RAZORPAY', 
        apiKey, 
        secret, 
        webhookSecret, 
        isActive, 
        mode 
      },
    });
    
    res.json({ success: true, message: 'Saved!', gateway });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const deactivateSuperAdminGateway = async (req, res) => {
  try {
    await prisma.superAdminPaymentGateway.updateMany({
      where: { name: 'RAZORPAY' },
      data: { isActive: false },
    });
    res.json({ success: true, message: 'Deactivated' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
