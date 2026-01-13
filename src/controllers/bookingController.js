import prisma from '../prisma.js';
import Razorpay from 'razorpay';
import Stripe from 'stripe';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { sendBookingEmails } from '../utils/email.js'
import { logAudit } from '../utils/audit.js';
import { google } from 'googleapis';
// ----------------------------------------------------------------
// Helper: load plan for a clinic
// ----------------------------------------------------------------
async function getClinicPlan(clinicId) {
  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    include: {
      subscription: {
        include: { plan: true },
      },
    },
  });
  return clinic?.subscription?.plan || null;
}

// ----------------------------------------------------------------
// HELPER: Get Gateway Instance
// ----------------------------------------------------------------
const getPaymentInstance = async (clinicId, provider = 'RAZORPAY') => {
  const gateway = await prisma.paymentGateway.findFirst({
    where: {
      clinicId,
      isActive: true,
      name: provider,
    },
  });

  if (!gateway || !gateway.apiKey || !gateway.secret) {
    throw new Error(`${provider} payments are not configured for this clinic.`);
  }

  const secretKey = gateway.secret;

  if (provider === 'STRIPE') {
    return {
      instance: new Stripe(secretKey),
      publicKey: gateway.apiKey,
      gatewayId: gateway.id,
      provider: 'STRIPE',
    };
  }

  // Razorpay
  return {
    instance: new Razorpay({
      key_id: gateway.apiKey,
      key_secret: secretKey,
    }),
    key_id: gateway.apiKey,
    gatewayId: gateway.id,
    provider: 'RAZORPAY',
  };
};


  // Razorpay

// ----------------------------------------------------------------
// CREATE BOOKING (Online/Offline/Free) - 100% RACE CONDITION PROOF
// ----------------------------------------------------------------
// ----------------------------------------------------------------
// CREATE BOOKING (Online/Offline/Free) - with hold + reuse
// ----------------------------------------------------------------
// src/controllers/bookingController.js

// ✅ ADD THIS IMPORT

// export const createBooking = async (req, res) => {
//   try {
//     const { slotId, paymentMethod = 'ONLINE', provider = 'RAZORPAY' } = req.body;
//     const authUserId = req.user?.userId;

//     console.log('🔑 Auth header:', req.headers.authorization);
//     console.log('👤 req.user:', req.user);

//     if (!authUserId) return res.status(401).json({ error: 'Unauthorized' });

//     const HOLD_MS = 10 * 60 * 1000;        // 10min payment window
//     const SAFETY_MS = 15 * 60 * 1000;      // 15min safety buffer
//     const now = new Date();

//     // 1. Fetch Slot + Clinic + Doctor (read-only)
//     const slotData = await prisma.slot.findUnique({
//       where: { id: slotId },
//       include: { clinic: true, doctor: true },
//     });

//     if (!slotData) return res.status(404).json({ error: 'Slot not found' });

//     // 🔥 2. RECENT HOLD CHECK (protect frontend refreshes)
//     const recentHold = await prisma.appointment.findFirst({
//       where: {
//         slotId,
//         deletedAt: null,
//         status: 'PENDING_PAYMENT',
//         createdAt: { gte: new Date(now.getTime() - SAFETY_MS) }
//       },
//     });

//     if (recentHold) {
//       if (recentHold.userId !== authUserId) {
//         return res.status(409).json({
//           error: 'Slot on hold by another user. Please wait 10-15 mins or choose another.',
//           retry: true,
//         });
//       }
//       // Same user → refresh hold
//       return handleExistingHold(recentHold, slotData, provider, now, HOLD_MS, res);
//     }

//     // 3. Plan validation (critical business rule)
//     const plan = await getClinicPlan(slotData.clinicId);
//     if (!plan) {
//       return res.status(400).json({ error: 'Clinic has no active subscription plan.' });
//     }

//     if (paymentMethod === 'ONLINE' && !plan.allowOnlinePayments) {
//       return res.status(403).json({
//         error: 'Online payments disabled. Use FREE or OFFLINE slots.',
//         availableModes: ['FREE', 'OFFLINE'],
//       });
//     }

//     // 🔥 4. ATOMIC TRANSACTION - IMPOSSIBLE RACE CONDITION!
//     const result = await prisma.$transaction(async (tx) => {
//       // CLEANUP: ONLY ancient (>15min) or CANCELLED records
//       await tx.appointment.deleteMany({
//         where: {
//           slotId,
//           OR: [
//             { status: 'CANCELLED' },
//             { status: 'PENDING' },
//             { 
//               status: 'PENDING_PAYMENT',
//               createdAt: { lt: new Date(now.getTime() - SAFETY_MS) }
//             }
//           ]
//         }
//       });

//       console.log('🧹 Ancient records cleaned (15min+ safety buffer)');

//       // FINAL SAFETY CHECKS
//       const confirmed = await tx.appointment.findFirst({
//         where: { slotId, status: 'CONFIRMED', deletedAt: null }
//       });
//       if (confirmed) throw new Error('ALREADY_CONFIRMED');

//       const otherHold = await tx.appointment.findFirst({
//         where: {
//           slotId,
//           userId: { not: authUserId },
//           status: 'PENDING_PAYMENT',
//           deletedAt: null
//         }
//       });
//       if (otherHold) throw new Error('SLOT_BLOCKED');

//       // 🔥 FREE/OFFLINE → INSTANT PENDING (Clinic approves later)
//       if (slotData.paymentMode === 'FREE' || paymentMethod === 'OFFLINE' || slotData.paymentMode === 'OFFLINE') {
//         const appointment = await tx.appointment.create({
//           data: {
//             userId: authUserId,
//             slotId,
//             clinicId: slotData.clinicId,
//             doctorId: slotData.doctorId,
//             status: 'PENDING',
//             paymentStatus: slotData.paymentMode === 'FREE' ? 'PAID' : 'PENDING',
//             amount: slotData.paymentMode === 'FREE' ? 0 : Number(slotData.price),
//             slug: `${slotData.paymentMode?.toLowerCase() || 'offline'}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
//             section: 'GENERAL',
//           },
//         });
//         return { appointment, isOnline: false, createNew: true };
//       }

//       // 🔥 ONLINE → RAZORPAY HOLD + ORDER (ATOMIC!)
//       const gateway = await getPaymentInstance(slotData.clinicId, provider);
//       const orderData = await createPaymentOrder(gateway, slotData, provider);

//       const appointment = await tx.appointment.create({
//         data: {
//           userId: authUserId,
//           slotId,
//           clinicId: slotData.clinicId,
//           doctorId: slotData.doctorId,
//           status: 'PENDING_PAYMENT',
//           paymentStatus: 'PENDING',
//           orderId: orderData.orderId || orderData.sessionId,
//           amount: Number(slotData.price),
//           slug: `hold_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
//           section: 'GENERAL',
//           paymentExpiry: new Date(now.getTime() + HOLD_MS),
//           createdAt: now, // Fresh timestamp for hold timer
//         },
//       });

//       return { 
//         appointment, 
//         gatewayId: gateway.gatewayId,
//         orderData,
//         isOnline: true, 
//         createNew: true 
//       };
//     });

//     // 5. SUCCESS PROCESSING
//     const { appointment, gatewayId, orderData, isOnline, createNew } = result;
    
//     // NON-BLOCKING EMAILS (OFFLINE/FREE only)
//     if (!isOnline && createNew) {
//       getUserById(authUserId).then(user => {
//         sendBookingEmails({
//           id: appointment.id,
//           clinic: slotData.clinic,
//           doctor: slotData.doctor,
//           slot: slotData,
//           user: user || { name: 'Patient', phone: 'N/A' }
//         }).catch(err => console.error('Pending booking emails failed:', err));
//       }).catch(() => {});
//     }

//     console.log('✅ Booking decision:', {
//       slotId,
//       authUserId,
//       path: isOnline ? 'NEW_ONLINE_HOLD' : 'OFFLINE_PENDING',
//       appointmentId: appointment.id,
//       status: appointment.status,
//     });

//     // PERFECT PRODUCTION RESPONSE
//     return res.json({
//       success: true,
//       appointmentId: appointment.id,
//       gatewayId,
//       isOnline,
//       orderId: orderData?.orderId || orderData?.sessionId,
//       amount: Number(slotData.price),
//       ...orderData,
//       expiresIn: isOnline ? HOLD_MS / 1000 : 0,
//       message: isOnline 
//         ? `Payment hold created! Complete within 10 mins - ₹${slotData.price}`
//         : slotData.paymentMode === 'FREE' 
//           ? 'Free booking created! Clinic will confirm soon.'
//           : `Booking created! Pay ₹${slotData.price} at clinic on visit.`,
//     });

//   } catch (error) {
//     console.error('🚨 CRITICAL BOOKING ERROR:', error);

//     // PRODUCTION ERROR HANDLING
//     if (error.message === 'SLOT_BLOCKED') {
//       return res.status(409).json({
//         error: 'Slot on hold by another patient. Wait 10-15 mins or choose another.',
//         retry: true,
//       });
//     }

//     if (error.message === 'ALREADY_CONFIRMED') {
//       return res.status(400).json({
//         error: 'You already have a confirmed booking for this slot.',
//       });
//     }

//     // PRISMA SAFETY NET
//     if (error.code === 'P2002') {
//       return res.status(409).json({
//         error: 'Slot taken instantly by another patient! Please refresh.',
//         retry: true,
//       });
//     }

//     return res.status(500).json({
//       error: error.message || 'Booking system temporarily unavailable.',
//     });
//   }
// };
// ✅ FULLY FIXED createBooking - Handles ALL FK + Race Conditions!
// export const createBooking = async (req, res) => {
//   try {
//     const { slotId, paymentMethod = 'ONLINE', provider = 'RAZORPAY' } = req.body;
//     const authUserId = req.user?.userId;

//     console.log('🔑 Auth header:', req.headers.authorization);
//     console.log('👤 req.user:', req.user);

//     if (!authUserId) return res.status(401).json({ error: 'Unauthorized' });

//     const HOLD_MS = 10 * 60 * 1000;
//     const SAFETY_MS = 15 * 60 * 1000;
//     const now = new Date();

//     // 1. Fetch Slot + Clinic + Doctor
//     const slotData = await prisma.slot.findUnique({
//       where: { id: slotId },
//       include: { clinic: true, doctor: true },
//     });

//     if (!slotData) return res.status(404).json({ error: 'Slot not found' });

//     // 2. RECENT HOLD CHECK
//     const recentHold = await prisma.appointment.findFirst({
//       where: {
//         slotId,
//         deletedAt: null,
//         status: 'PENDING_PAYMENT',
//         createdAt: { gte: new Date(now.getTime() - SAFETY_MS) }
//       },
//     });

//     if (recentHold) {
//       if (recentHold.userId !== authUserId) {
//         return res.status(409).json({
//           error: 'Slot on hold by another user. Please wait 10-15 mins or choose another.',
//           retry: true,
//         });
//       }
//       return handleExistingHold(recentHold, slotData, provider, now, HOLD_MS, res, slotData.clinicId, req);
//     }

//     // 3. Plan validation
//     const plan = await getClinicPlan(slotData.clinicId);
//     if (!plan) {
//       return res.status(400).json({ error: 'Clinic has no active subscription plan.' });
//     }

//     if (paymentMethod === 'ONLINE' && !plan.allowOnlinePayments) {
//       return res.status(403).json({
//         error: 'Online payments disabled. Use FREE or OFFLINE slots.',
//         availableModes: ['FREE', 'OFFLINE'],
//       });
//     }

//     // 🔥 4. ATOMIC TRANSACTION - FULLY FIXED CLEANUP!
//     const result = await prisma.$transaction(async (tx) => {
//       console.log('🧹 DEBUG: Checking stale appointments for slotId:', slotId);
//       // 🔥 COMPLETE STALE CLEANUP (ALL CHILDREN FIRST!)
//       const staleAppts = await tx.appointment.findMany({
//         where: {
//           slotId,
//              OR: [
//       { 
//         status: 'PENDING', 
//         createdAt: { lt: new Date(now.getTime() - SAFETY_MS) } 
//       }, 
//       { 
//         status: 'PENDING_PAYMENT',
//         createdAt: { lt: new Date(now.getTime() - SAFETY_MS) }
//       }
//     ]
//   },
      
//         select: { id: true }
//       });

//       const staleIds = staleAppts.map(a => a.id);
      
//       if (staleIds.length > 0) {
//         console.log(`🧹 Cleaning ${staleIds.length} stale appointments + children`);
        
//         // CRITICAL ORDER: Children → Parent (No FK Violations!)
//         await tx.cancellationRequest.deleteMany({  // 🔥 ADDED
//           where: { appointmentId: { in: staleIds } }
//         });
//         await tx.payment.deleteMany({
//           where: { appointmentId: { in: staleIds } }
//         });
//         await tx.appointmentLog.deleteMany({  // 🔥 ADDED
//           where: { appointmentId: { in: staleIds } }
//         });
        
//         // NOW safe to delete appointments
//         await tx.appointment.deleteMany({
//           where: { id: { in: staleIds } }
//         });
        
//         console.log(`✅ Cleaned ${staleIds.length} appts + payments/requests/logs`);
//       }
//       const freshSlot = await tx.slot.findUnique({
//     where: { id: slotId },
//     select: { isBlocked: true, status: true }
//   });

//   if (!freshSlot) throw new Error('SLOT_NOT_FOUND');
  
//   // Check if Admin blocked it while user was on the page
//   if (freshSlot.isBlocked) {
//     throw new Error('ADMIN_BLOCKED');
//   }
//   // ============================================================

//       // SAFETY CHECKS (Inside transaction!)
//       const confirmed = await tx.appointment.findFirst({
//         where: { slotId, status: 'CONFIRMED', deletedAt: null }
//       });
//       if (confirmed) throw new Error('ALREADY_CONFIRMED');

//       const otherHold = await tx.appointment.findFirst({
//         where: {
//           slotId,
//           userId: { not: authUserId },
//           status: 'PENDING_PAYMENT',
//           deletedAt: null
//         }
//       });
//       if (otherHold) throw new Error('SLOT_BLOCKED');

//       // FREE/OFFLINE → INSTANT PENDING
//       if (slotData.paymentMode === 'FREE' || paymentMethod === 'OFFLINE' || slotData.paymentMode === 'OFFLINE') {
//         const appointment = await tx.appointment.create({
//           data: {
//             userId: authUserId,
//             slotId,
//             clinicId: slotData.clinicId,
//             doctorId: slotData.doctorId,
//             status: 'PENDING',
//             paymentStatus: slotData.paymentMode === 'FREE' ? 'PAID' : 'PENDING',
//             amount: slotData.paymentMode === 'FREE' ? 0 : Number(slotData.price),
//             slug: `${slotData.paymentMode?.toLowerCase() || 'offline'}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
//             section: 'GENERAL',
//           },
//         });
//         return { appointment, isOnline: false, createNew: true };
//       }

//       // ONLINE → RAZORPAY HOLD + ORDER
//       const gateway = await getPaymentInstance(slotData.clinicId, provider);
//       const orderData = await createPaymentOrder(gateway, slotData, provider);
// const activeAppointment = await tx.appointment.findFirst({
//   where: {
//     slotId,
//     status: { in: ['CONFIRMED', 'PENDING', 'PENDING_PAYMENT'] },
//     deletedAt: null,
//   },
// });

// if (activeAppointment) {
//   throw new Error('SLOT_ALREADY_BOOKED');
// }

//       const appointment = await tx.appointment.create({
//         data: {
//           userId: authUserId,
//           slotId,
//           clinicId: slotData.clinicId,
//           doctorId: slotData.doctorId,
//           status: 'PENDING_PAYMENT',
//           paymentStatus: 'PENDING',
//           orderId: orderData.orderId || orderData.sessionId,
//           amount: Number(slotData.price),
//           slug: `hold_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
//           section: 'GENERAL',
//           paymentExpiry: new Date(now.getTime() + HOLD_MS),
//           createdAt: now,
//         },
//       });

//       return { 
//         appointment, 
//         gatewayId: gateway.gatewayId,
//         orderData,
//         isOnline: true, 
//         createNew: true 
//       };
//     });

//     // 5. SUCCESS PROCESSING + AUDIT LOG (unchanged)
//     const { appointment, gatewayId, orderData, isOnline, createNew } = result;
    
//     await logAudit({
//       userId: authUserId,
//       clinicId: slotData.clinicId,
//       action: isOnline ? 'BOOKING_HOLD_CREATED_ONLINE' : 'BOOKING_CREATED_OFFLINE',
//       entity: 'Appointment',
//       entityId: appointment.id,
//       details: {
//         slotId,
//         doctorId: slotData.doctorId,
//         doctorName: slotData.doctor.name,
//         paymentMode: slotData.paymentMode,
//         paymentMethod,
//         provider: isOnline ? provider : null,
//         orderId: isOnline ? (orderData?.orderId || orderData?.sessionId) : null,
//         amount: Number(slotData.price),
//         status: appointment.status,
//         isOnline,
//         paymentExpiry: appointment.paymentExpiry || null,
//       },
//       req,
//     });


//     // NON-BLOCKING EMAILS (unchanged)
//     if (!isOnline && createNew) {
//       getUserById(authUserId).then(user => {
//         sendBookingEmails({
//           id: appointment.id,
//           clinic: slotData.clinic,
//           doctor: slotData.doctor,
//           slot: slotData,
//           user: user || { name: 'Patient', phone: 'N/A' }
//         }).catch(err => console.error('Pending booking emails failed:', err));
//       }).catch(() => {});
//     }
    

//     console.log('✅ Booking decision:', {
//       slotId,
//       authUserId,
//       path: isOnline ? 'NEW_ONLINE_HOLD' : 'OFFLINE_PENDING',
//       appointmentId: appointment.id,
//       status: appointment.status,
//     });

//     return res.json({
//       success: true,
//       appointmentId: appointment.id,
//       gatewayId,
//       isOnline,
//       orderId: orderData?.orderId || orderData?.sessionId,
//       amount: Number(slotData.price),
//       ...orderData,
//       expiresIn: isOnline ? HOLD_MS / 1000 : 0,
//       message: isOnline 
//         ? `Payment hold created! Complete within 10 mins - ₹${slotData.price}`
//         : slotData.paymentMode === 'FREE' 
//         ? 'Free booking created! Clinic will confirm soon.'
//         : `Booking created! Pay ₹${slotData.price} at clinic on visit.`,
//     });

//   } catch (error) {
//     console.error('🚨 CRITICAL BOOKING ERROR:', error);

//     if (error.message === 'SLOT_BLOCKED') {
//       return res.status(409).json({
//         error: 'Slot on hold by another patient. Wait 10-15 mins or choose another.',
//         retry: true,
//       });
//     }

//     if (error.message === 'ALREADY_CONFIRMED') {
//       return res.status(400).json({
//         error: 'You already have a confirmed booking for this slot.',
//       });
//     }

//     if (error.code === 'P2002') {
//       return res.status(409).json({
//         error: 'Slot taken instantly by another patient! Please refresh.',
//         retry: true,
//       });
//     }

//     return res.status(500).json({
//       error: error.message || 'Booking system temporarily unavailable.',
//     });
//   }
// };
export const createBooking = async (req, res) => {
  try {
    const { slotId, paymentMethod = 'ONLINE', provider = 'RAZORPAY' } = req.body;
    const authUserId = req.user?.userId;

    if (!authUserId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const HOLD_MS = 10 * 60 * 1000;
    const SAFETY_MS = 15 * 60 * 1000;
    const now = new Date();

    // 1️⃣ Fetch slot
    const slotData = await prisma.slot.findUnique({
      where: { id: slotId },
      include: { clinic: true, doctor: true },
    });

    if (!slotData) {
      return res.status(404).json({ error: 'Slot not found' });
    }

    // 2️⃣ Recent hold check (same user allowed)
    const recentHold = await prisma.appointment.findFirst({
      where: {
        slotId,
        status: 'PENDING_PAYMENT',
        deletedAt: null,
        createdAt: { gte: new Date(now.getTime() - SAFETY_MS) },
      },
    });

    if (recentHold) {
      if (recentHold.userId !== authUserId) {
        return res.status(409).json({
          error: 'Slot on hold by another user. Please wait or choose another.',
          retry: true,
        });
      }

      return handleExistingHold(
        recentHold,
        slotData,
        provider,
        now,
        HOLD_MS,
        res,
        slotData.clinicId,
        req
      );
    }

    // 3️⃣ Plan validation
    const plan = await getClinicPlan(slotData.clinicId);
    if (!plan) {
      return res.status(400).json({ error: 'Clinic has no active subscription plan.' });
    }

    if (paymentMethod === 'ONLINE' && !plan.allowOnlinePayments) {
      return res.status(403).json({
        error: 'Online payments disabled.',
        availableModes: ['FREE', 'OFFLINE'],
      });
    }

    // 4️⃣ TRANSACTION
    const result = await prisma.$transaction(async (tx) => {

      // 🧹 Delete ONLY expired online holds
      await tx.appointment.deleteMany({
        where: {
          slotId,
          status: 'PENDING_PAYMENT',
          createdAt: { lt: new Date(now.getTime() - SAFETY_MS) },
        },
      });

      // 🔒 Slot state check
      const freshSlot = await tx.slot.findUnique({
        where: { id: slotId },
        select: { isBlocked: true, status: true },
      });

      if (!freshSlot) throw new Error('SLOT_NOT_FOUND');
      if (freshSlot.isBlocked || freshSlot.status !== 'PENDING_PAYMENT') {
        throw new Error('SLOT_NOT_AVAILABLE');
      }

      // 🔥 SINGLE blocking rule
      const activeAppointment = await tx.appointment.findFirst({
        where: {
          slotId,
          status: { in: ['CONFIRMED', 'PENDING', 'PENDING_PAYMENT'] },
          deletedAt: null,
        },
      });

      if (activeAppointment) {
        throw new Error('SLOT_ALREADY_BOOKED');
      }

      // 5️⃣ FREE / OFFLINE booking
      if (
        slotData.paymentMode === 'FREE' ||
        paymentMethod === 'OFFLINE' ||
        slotData.paymentMode === 'OFFLINE'
      ) {
        const appointment = await tx.appointment.create({
          data: {
            userId: authUserId,
            slotId,
            clinicId: slotData.clinicId,
            doctorId: slotData.doctorId,
            status: 'PENDING',
            paymentStatus: slotData.paymentMode === 'FREE' ? 'PAID' : 'PENDING',
            amount: slotData.paymentMode === 'FREE' ? 0 : Number(slotData.price),
            slug: `offline_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            section: 'GENERAL',
          },
        });

        return { appointment, isOnline: false };
      }

      // 6️⃣ ONLINE — OLD RAZORPAY FLOW (WORKING STYLE)
      const gateway = await getPaymentInstance(slotData.clinicId, provider);

      if (!gateway?.instance || !gateway?.key_id) {
        throw new Error('PAYMENT_CONFIG_MISSING');
      }

      const options = {
        amount: Math.round(Number(slotData.price) * 100),
        currency: 'INR',
        receipt: `rcpt_${slotId.slice(-6)}_${Date.now()}`,
        notes: {
          slotId,
          clinicId: slotData.clinicId,
          doctorId: slotData.doctorId,
        },
      };

      const order = await gateway.instance.orders.create(options);

      const appointment = await tx.appointment.create({
        data: {
          userId: authUserId,
          slotId,
          clinicId: slotData.clinicId,
          doctorId: slotData.doctorId,
          status: 'PENDING_PAYMENT',
          paymentStatus: 'PENDING',
          orderId: order.id,
          amount: Number(slotData.price),
          slug: `hold_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
          section: 'GENERAL',
          paymentExpiry: new Date(now.getTime() + HOLD_MS),
        },
      });

      return {
        appointment,
        isOnline: true,
        orderId: order.id,
        key: gateway.key_id, // 🔥 SAME AS OLD CODE
        amount: order.amount,
      };
    });

    // 7️⃣ Audit log
    await logAudit({
      userId: authUserId,
      clinicId: slotData.clinicId,
      action: result.isOnline ? 'BOOKING_HOLD_CREATED_ONLINE' : 'BOOKING_CREATED_OFFLINE',
      entity: 'Appointment',
      entityId: result.appointment.id,
      req,
    });

    // 8️⃣ Response
    return res.json({
      success: true,
      appointmentId: result.appointment.id,
      isOnline: result.isOnline,
      orderId: result.orderId,
      key: result.key,
      amount: Number(slotData.price),
      expiresIn: result.isOnline ? HOLD_MS / 1000 : 0,
      message: result.isOnline
        ? 'Payment hold created. Complete payment within 10 minutes.'
        : 'Booking created successfully.',
    });

  } catch (error) {
    console.error('🚨 BOOKING ERROR:', error);

    if (error.message === 'SLOT_ALREADY_BOOKED') {
      return res.status(409).json({
        error: 'Slot already booked. Please choose another.',
        retry: true,
      });
    }

    if (error.message === 'PAYMENT_CONFIG_MISSING') {
      return res.status(500).json({
        error: 'Payment configuration missing. Please contact clinic.',
      });
    }

    return res.status(500).json({
      error: 'Booking system temporarily unavailable.',
    });
  }
};
export const autoSyncAppointmentToGCal = async (appointmentId) => {
  try {
    const appt = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: { 
        clinic: true,
        slot: { include: { doctor: true } },
        user: true
      }
    });

    if (!appt || appt.status !== "CONFIRMED") return;

    const plan = await getClinicPlan(appt.clinicId);
    const doBoth = plan?.enableGoogleCalendarSync;

    const doctor = appt.slot.doctor;
    const clinic = appt.clinic;

    // 🧠 Doctor calendar
    if (doctor?.googleRefreshToken) {
      const doctorEventId = await syncToCalendar({
        refreshToken: doctor.googleRefreshToken,
        calendarId: doctor.googleCalendarId || "primary",
        appt,
        source: "doctor"
      });

      await prisma.appointment.update({
        where: { id: appt.id },
        data: { googleCalendarDoctorEventId: doctorEventId }
      });
    }

    // 🧠 Clinic calendar
    if (clinic?.googleRefreshToken && doBoth) {
      const clinicEventId = await syncToCalendar({
        refreshToken: clinic.googleRefreshToken,
        calendarId: clinic.googleCalendarId || "primary",
        appt,
        source: "clinic"
      });

      await prisma.appointment.update({
        where: { id: appt.id },
        data: { googleCalendarClinicEventId: clinicEventId }
      });
    }

  } catch (error) {
    console.error("🚨 GCal Sync Error:", error.message);
  }
};


// Helper function (reusable)
const syncToCalendar = async ({ refreshToken, calendarId, appt, source }) => {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  const calendar = google.calendar({ version: "v3", auth: oauth2Client });

  const slotDate = new Date(appt.slot.date);
  const [hours, minutes] = appt.slot.time.split(':').map(Number);

  const startDateTime = new Date(Date.UTC(
    slotDate.getFullYear(),
    slotDate.getMonth(),
    slotDate.getDate(),
    hours,
    minutes
  ));

  const endDateTime = new Date(startDateTime.getTime() + 30 * 60000);

  const event = await calendar.events.insert({
    calendarId,
    sendUpdates: "all",
    requestBody: {
      summary: `🏥 ${appt.user.name} - ${appt.slot.doctor.name}`,
      description: `Appt ID: ${appt.id}`,
      start: { dateTime: startDateTime.toISOString(), timeZone: "Asia/Kolkata" },
      end: { dateTime: endDateTime.toISOString(), timeZone: "Asia/Kolkata" },
    }
  });

  console.log(`✅ GCal ${source}:`, event.data.htmlLink);

  return event.data.id; // 🔥 THIS IS THE KEY FIX
};




// 🔥 PRODUCTION HELPER: Refresh existing hold (same user only)
// ✅ FIXED handleExistingHold (Updated signature + fix)
async function handleExistingHold(existing, slotData, provider, now, HOLD_MS, res, clinicId, req) {
  try {
    const expiresAt = existing.paymentExpiry || new Date(existing.createdAt.getTime() + HOLD_MS);
    const remainingMs = new Date(expiresAt).getTime() - now.getTime();

    console.log('🔄 Hold refresh:', {
      appointmentId: existing.id,
      remainingMs,
      paymentExpiry: existing.paymentExpiry?.toISOString(),
    });

    // 🔥 FIXED: Pass clinicId to getPaymentInstance!
    const gateway = await getPaymentInstance(clinicId, provider);
    const orderData = await createPaymentOrder(gateway, slotData, provider);

    // Extend hold expiry
    const updatedAppointment = await prisma.appointment.update({
      where: { id: existing.id },
      data: { 
        orderId: orderData.orderId || orderData.sessionId,
        paymentExpiry: new Date(now.getTime() + HOLD_MS),
        updatedAt: now,
      },
    });

    // 🔥 AUDIT LOG (now req available!)
    await logAudit({
      userId: req.user.userId,
      clinicId,
      action: 'BOOKING_HOLD_REFRESHED',
      entity: 'Appointment',
      entityId: existing.id,
      details: {
        slotId: existing.slotId,
        doctorId: slotData.doctorId,
        doctorName: slotData.doctor.name,
        provider,
        oldOrderId: existing.orderId,
        newOrderId: orderData.orderId || orderData.sessionId,
        oldExpiry: existing.paymentExpiry,
        newExpiry: updatedAppointment.paymentExpiry,
        remainingMsBefore: remainingMs,
        amount: Number(slotData.price),
      },
      req,
    });

    return res.json({
      success: true,
      appointmentId: existing.id,
      gatewayId: gateway.gatewayId,
      isOnline: true,
      ...orderData,
      expiresIn: HOLD_MS / 1000,
      message: `Payment refreshed! New 10-minute window - ₹${slotData.price}`,
    });

  } catch (error) {
    console.error('Hold refresh failed:', error);
    
    // 🔥 BETTER ERROR HANDLING
    if (error.statusCode === 401 || error.code === 'BAD_REQUEST_ERROR') {
      return res.status(401).json({
        error: 'Payment gateway authentication failed. Please refresh and try again.',
      });
    }
    
    return res.status(500).json({
      error: 'Failed to refresh payment hold.',
    });
  }
}





// ✅ HELPER FUNCTION - Get user data for emails
const getUserById = async (userId) => {
  try {
    return await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, phone: true, email: true }
    });
  } catch {
    return null;
  }
};


// ✅ HELPER - Get user data for emails



// Helper function - extract payment order creation
async function createPaymentOrder(gateway, slot, provider) {
  if (gateway.provider === 'RAZORPAY') {
    const options = {
      amount: Math.round(Number(slot.price) * 100),
      currency: 'INR',
      receipt: `rcpt_${slot.id.slice(-8)}_${Date.now()}`,
      notes: {
        appointmentTempId: uuidv4(),
        slotId: slot.id,
        clinicId: slot.clinicId,
        doctorId: slot.doctorId,
      },
    };

    const order = await gateway.instance.orders.create(options);
    return {
      provider: 'RAZORPAY',
      orderId: order.id,
      amount: order.amount, // paise
      key: gateway.key_id,
    };
  } else if (gateway.provider === 'STRIPE') {
    const session = await gateway.instance.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'inr',
          product_data: {
            name: `Appointment: Dr. ${slot.doctor?.name || 'Doctor'} - ${slot.time}`,
            description: `${slot.clinic.name} • ${new Date(slot.date).toLocaleDateString()}`,
          },
          unit_amount: Math.round(Number(slot.price) * 100),
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/booking/${slot.id}`,
      metadata: {
        appointmentTempId: uuidv4(),
        slotId: slot.id,
        clinicId: slot.clinicId,
        doctorId: slot.doctorId,
      },
    });

    return {
      provider: 'STRIPE',
      sessionId: session.id,
      url: session.url,
      publishableKey: gateway.publicKey,
    };
  }
}


// ----------------------------------------------------------------
// VERIFY RAZORPAY PAYMENT (Your code + expiry check)
// ----------------------------------------------------------------
export const verifyPayment = async (req, res) => {
  try {
    const { 
      razorpay_order_id, 
      razorpay_payment_id, 
      razorpay_signature, 
      appointmentId,
      notes 
    } = req.body;

    if (!appointmentId) return res.status(400).json({ error: 'Appointment ID required' });

    console.log('🔍 VERIFYING (UPSERT MODE - FIXED):', { appointmentId, paymentId: razorpay_payment_id });

    // 1. Fetch Appointment
    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: { 
        clinic: { include: { gateways: true } },
        doctor: true,
        user: true,
        slot: true 
      }
    });

    if (!appointment) return res.status(404).json({ error: 'Appointment not found' });

    // 2. Gateway Check
    const gateway = appointment.clinic.gateways.find(g => g.name === 'RAZORPAY' && g.isActive);
    if (!gateway?.secret) return res.status(400).json({ error: 'Gateway config missing' });

    // 3. Verify Signature
    const generated_signature = crypto
      .createHmac('sha256', gateway.secret)
      .update(razorpay_order_id + '|' + razorpay_payment_id)
      .digest('hex');
      console.log("---------------- PAYMENT DEBUG ----------------");
console.log("🛠️ SECRET USED (First 4 chars):", gateway.secret?.substring(0, 4) + "****"); 
console.log("🛠️ STRING TO SIGN:", razorpay_order_id + '|' + razorpay_payment_id);
console.log("🛠️ GENERATED SIGNATURE:", generated_signature);
console.log("🛠️ RECEIVED SIGNATURE:", razorpay_signature);
console.log("-----------------------------------------------");

    if (generated_signature !== razorpay_signature) {
      return res.status(400).json({ error: 'Invalid payment signature' });
    }

    // 🔥 4. TRANSACTION
    const result = await prisma.$transaction(async (tx) => {
      const amountPaid = notes?.amount ? Number(notes.amount) : Number(appointment.amount);

      // A. Update Appointment
      const updatedAppt = await tx.appointment.update({
        where: { id: appointmentId },
        data: {
          status: "CONFIRMED",
          paymentStatus: "PAID",
          financialStatus: "PAID",
          paymentId: razorpay_payment_id,
          orderId: razorpay_order_id,
          adminNote: `Payment Verified: ${razorpay_payment_id}`,
          updatedAt: new Date()
        },
        include: { slot: true, clinic: true, doctor: true, user: true }
      });

      // B. Update Slot (FIXED: Removed isBooked)
      if (updatedAppt.slotId) {
        await tx.slot.update({
          where: { id: updatedAppt.slotId },
          data: { 
            status: "CONFIRMED", // This marks it as booked/confirmed
            isBlocked: false     // Release the temporary hold
          }
        });
      }

      // C. Upsert Payment
      await tx.payment.upsert({
        where: { appointmentId: appointmentId }, 
        update: {
          amount: amountPaid,
          gatewayRefId: razorpay_payment_id,
          status: "PAID",
          gatewayId: gateway.id,
          createdAt: new Date()
        },
        create: {
          appointmentId: appointmentId,
          clinicId: appointment.clinicId,
          doctorId: appointment.doctorId,
          gatewayId: gateway.id,
          amount: amountPaid,
          status: "PAID",
          gatewayRefId: razorpay_payment_id
        }
      });

      return updatedAppt;
    });
// if (result.status === "CONFIRMED") {
//   const plan = await getClinicPlan(result.clinicId);
//   if (plan?.enableGoogleCalendarSync) {
//     // Non-blocking - don't delay payment response
//     autoSyncAppointmentToGCal(result.id).catch(err => {
//       console.error("❌ GCal sync failed:", err.message);
//     });
//   }
// }
if (result.status === "CONFIRMED") {
  const plan = await getClinicPlan(result.clinicId);
  if (plan?.enableGoogleCalendarSync) {
    // Smart sync: Update if exists, create if new
    if (result.googleCalendarEventId) {
      autoSyncAppointmentToGCal(result.id).catch(err => {
        console.error("❌ GCal update failed:", err.message);
      });
    } else {
      autoSyncAppointmentToGCal(result.id).catch(err => {
        console.error("❌ GCal create failed:", err.message);
      });
    }
  }
}
    // 5. Send Email
    sendBookingEmails({
      type: notes?.type === 'RESCHEDULE' ? "RESCHEDULE_CONFIRMED" : "CONFIRMED",
      id: result.id,
      clinic: result.clinic,
      doctor: result.doctor,
      slot: result.slot,
      user: result.user
    }).catch(console.error);

    return res.json({ success: true, message: "Payment verified!", data: result });

  } catch (error) {
    console.error('🚨 VERIFY ERROR:', error);
    return res.status(500).json({ error: 'Payment verification failed' });
  }
};


// ---------------------------------------------------------------------
// STRIPE FRONTEND VERIFICATION
// ---------------------------------------------------------------------
export const verifyStripePayment = async (req, res) => {
  try {
    const { session_id, appointmentId } = req.body;

    if (!session_id || !appointmentId) {
      return res.status(400).json({ error: 'Missing session_id or appointmentId' });
    }

    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: { 
        clinic: { include: { gateways: true } },
        doctor: true,
        user: true,
        slot: true 
      }
    });

    if (!appointment) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    // Expiry check (same as Razorpay)
    const now = new Date();
    const created15MinAgo = new Date(now.getTime() - 15 * 60 * 1000);
    if (appointment.createdAt < created15MinAgo && 
        appointment.paymentStatus !== 'PENDING') {
      await prisma.appointment.update({
        where: { id: appointmentId },
        data: { status: 'CANCELLED', paymentStatus: 'FAILED' }
      });
      return res.status(400).json({ error: 'Session expired' });
    }

    const gateway = appointment.clinic.gateways.find(g => g.name === 'STRIPE');
    if (!gateway) {
      return res.status(400).json({ error: 'Stripe gateway not configured' });
    }

    const stripe = new Stripe(gateway.secret);
    const session = await stripe.checkout.sessions.retrieve(session_id);

    if (session.payment_status === 'paid') {
      await prisma.$transaction(async (tx) => {
        const updatedAppt = await tx.appointment.update({
          where: { id: appointmentId },
          data: {
            status: 'CONFIRMED',
            paymentStatus: 'PAID',
            financialStatus: 'PAID',
            paymentId: session.payment_intent,
            adminNote: `Stripe verified: ${session.payment_intent}`
          },
          include: { clinic: true, doctor: true, user: true, slot: true }
        });

        await tx.slot.update({
          where: { id: appointment.slotId },
          data: { isBooked: true, status: 'CONFIRMED', isBlocked: false }
        });

        await tx.payment.create({
          data: {
            appointmentId: appointment.id,
            clinicId: appointment.clinicId,
            doctorId: appointment.doctorId,
            gatewayId: gateway.id,
            amount: Number(session.amount_total) / 100,
            status: 'PAID',
            gatewayRefId: session.payment_intent,
          }
        });

        sendBookingEmails({
          type: 'CONFIRMED',
          id: updatedAppt.id,
          clinic: updatedAppt.clinic,
          doctor: updatedAppt.doctor,
          slot: updatedAppt.slot,
          user: updatedAppt.user
        }).catch(console.error);
      });

      return res.json({ 
        success: true, 
        message: 'Stripe payment verified & booking confirmed!' 
      });
    } else {
      return res.status(400).json({ error: 'Payment not completed' });
    }

  } catch (error) {
    console.error('🚨 STRIPE ERROR:', error);
    return res.status(500).json({ error: 'Stripe verification failed' });
  }
};