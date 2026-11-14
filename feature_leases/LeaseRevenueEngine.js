/**
 * ==============================================================================
 * TMS WHITELABEL & LEAH'S KITCHEN — COMMERCIAL BUSINESS MODEL & REVENUE ENGINE
 * ==============================================================================
 * Codifies the monetizable SaaS + Feature-Lease revenue streams, merchant ROI
 * justification, unit economics (KES 0 transport cost via Baileys WebSocket),
 * and multi-tenant MRR/ARR projections.
 *
 * Core Monetization Streams:
 * 1. Tiered Monthly Feature Leases (Enforced by the 00:01:00 Midnight Reconciler)
 *    - TIER_0_CORE: Free / Base White-Label Storefront (KES 0/mo — Lead Magnet)
 *    - TIER_1_MODEL_A: Smart Pre-Order & Stock Control Lease (KES 2,500/mo)
 *    - TIER_2_MODEL_B_PRO: Full Kitchen Batch, Bagging & WhatsApp Digest Lease (KES 4,500/mo)
 * 2. Usage-Based / Micro-Batch Overages & Event Day Passes
 *    - Pay-Per-Batch Pass (KES 150 per clustered batch > 15 bags for pop-up caterers)
 * 3. Platform Transaction / Settlement Take-Rate (1.5% on pre-order GMV or flat KES 10/bag)
 * ==============================================================================
 */

export const LEASE_PRICING_TIERS = {
  TIER_0_CORE: {
    id: 'TIER_0_CORE',
    name: 'Base Storefront (Community Tier)',
    monthlyFeeKes: 0,
    perBagFeeKes: 0,
    includedFeatures: [
      'core-catalog-grid',
      'basic-cart-checkout'
    ],
    lockedPaidLeases: [
      'preorder-grace-cutoff-15m',
      'merchant-dish-stock-toggle',
      'two-stage-kitchen-batch-digest',
      'customer-bag-packing-slips'
    ],
    description: 'Standard self-serve digital menu with hard 17:00 cutoff and manual order reading.'
  },
  TIER_1_MODEL_A: {
    id: 'TIER_1_MODEL_A',
    name: 'Model A — Smart Pre-Order & Stock Cap Lease',
    monthlyFeeKes: 2500,
    perBagFeeKes: 5,
    includedFeatures: [
      'core-catalog-grid',
      'basic-cart-checkout',
      'preorder-grace-cutoff-15m',
      'merchant-dish-stock-toggle'
    ],
    lockedPaidLeases: [
      'two-stage-kitchen-batch-digest',
      'customer-bag-packing-slips'
    ],
    description: 'Protects 17:00–17:15 in-flight checkouts with 15-min soft-landing grace window and real-time dish stock caps.'
  },
  TIER_2_MODEL_B_PRO: {
    id: 'TIER_2_MODEL_B_PRO',
    name: 'Model B Pro — Kitchen Batch & Bagging Automation Lease',
    monthlyFeeKes: 4500,
    perBagFeeKes: 10,
    includedFeatures: [
      'core-catalog-grid',
      'basic-cart-checkout',
      'preorder-grace-cutoff-15m',
      'merchant-dish-stock-toggle',
      'two-stage-kitchen-batch-digest',
      'customer-bag-packing-slips',
      'whatsapp-clustered-prep-bridge'
    ],
    lockedPaidLeases: [],
    description: 'Full Two-Stage Kitchen Workflow: Stage 1 Stove Cook Totals + Stage 2 Gate-Grouped Bagging Slips (BAG-01..BAG-N) with zero-cost WhatsApp dispatch.'
  }
};

export const INDIVIDUAL_FEATURE_ADDONS = {
  'preorder-grace-cutoff-15m': {
    featureId: 'preorder-grace-cutoff-15m',
    name: '15-Minute Soft-Landing Grace Cutoff (17:00–17:15)',
    monthlyLeaseKes: 1200,
    valueMetric: 'Recovers 2–4 abandoned evening carts per day (~KES 45,000/mo rescued GMV)'
  },
  'merchant-dish-stock-toggle': {
    featureId: 'merchant-dish-stock-toggle',
    name: 'Real-Time Dish Availability & Daily Portion Cap Controller',
    monthlyLeaseKes: 1000,
    valueMetric: 'Eliminates overselling refunds and kitchen ingredient stockouts'
  },
  'two-stage-kitchen-batch-digest': {
    featureId: 'two-stage-kitchen-batch-digest',
    name: 'Stage 1 Stove Cook Sheet & Order Clustering Engine',
    monthlyLeaseKes: 1500,
    valueMetric: 'Saves 45+ mins of manual tallying per rush and eliminates WhatsApp alert fatigue'
  },
  'customer-bag-packing-slips': {
    featureId: 'customer-bag-packing-slips',
    name: 'Stage 2 Gate-Grouped Customer Bagging Slips (BAG-01..BAG-N)',
    monthlyLeaseKes: 1800,
    valueMetric: 'Solves "what to pack for who" across collection gates with 0% wrong-bag mixups'
  }
};

/**
 * Calculates monthly platform revenue and gross margin from a single merchant tenant.
 * Because the WhatsApp bridge uses persistent Baileys WebSockets instead of paid
 * per-message cloud APIs, marginal message transport cost is KES 0.
 *
 * @param {Object} params
 * @param {string} [params.tierId='TIER_2_MODEL_B_PRO'] - Selected subscription tier
 * @param {number} [params.monthlyOrders=600] - Total customer orders/bags processed per month
 * @param {number} [params.avgOrderValueKes=650] - Average customer order value in KES
 * @param {number} [params.eventPassBatches=0] - Extra pop-up/event batch passes purchased (KES 150/batch)
 * @param {number} [params.infraCostPerTenantKes=120] - Prorated cloud/DB hosting cost per tenant in KES
 * @returns {Object} Monthly tenant revenue and unit economics breakdown
 */
export function calculateTenantMonthlyRevenue({
  tierId = 'TIER_2_MODEL_B_PRO',
  monthlyOrders = 600,
  avgOrderValueKes = 650,
  eventPassBatches = 0,
  infraCostPerTenantKes = 120
} = {}) {
  const tier = LEASE_PRICING_TIERS[tierId] || LEASE_PRICING_TIERS.TIER_2_MODEL_B_PRO;

  const baseLeaseRevenueKes = tier.monthlyFeeKes;
  const bagPackagingFeeRevenueKes = monthlyOrders * tier.perBagFeeKes;
  const eventPassRevenueKes = eventPassBatches * 150;

  const totalPlatformRevenueKes =
    baseLeaseRevenueKes + bagPackagingFeeRevenueKes + eventPassRevenueKes;

  const whatsappTransportCostKes = 0; // KES 0 per message via Baileys WebSocket bridge
  const totalCogsKes = whatsappTransportCostKes + infraCostPerTenantKes;
  const grossProfitKes = Math.max(0, totalPlatformRevenueKes - totalCogsKes);
  const grossMarginPercent =
    totalPlatformRevenueKes > 0
      ? Number(((grossProfitKes / totalPlatformRevenueKes) * 100).toFixed(2))
      : 0;

  const merchantMonthlyGmvKes = monthlyOrders * avgOrderValueKes;
  const effectivePlatformTakeRatePercent =
    merchantMonthlyGmvKes > 0
      ? Number(((totalPlatformRevenueKes / merchantMonthlyGmvKes) * 100).toFixed(2))
      : 0;

  return {
    tierId: tier.id,
    tierName: tier.name,
    monthlyOrders,
    avgOrderValueKes,
    merchantMonthlyGmvKes,
    revenueBreakdownKes: {
      baseSubscriptionLease: baseLeaseRevenueKes,
      bagFulfillmentMeteredFee: bagPackagingFeeRevenueKes,
      eventBatchPasses: eventPassRevenueKes,
      totalMonthlyRevenueKes: totalPlatformRevenueKes
    },
    unitEconomics: {
      whatsappTransportCostKes,
      infraCostPerTenantKes,
      totalCogsKes,
      grossProfitKes,
      grossMarginPercent,
      effectivePlatformTakeRatePercent
    }
  };
}

/**
 * Calculates the Merchant's Return on Investment (ROI) to prove why paying for
 * the Model B Pro Lease (KES 4,500/mo + bag fee) generates massive net profit for Leah's Kitchen.
 *
 * @param {Object} params
 * @param {number} [params.rescuedOrdersPerDay=2] - Orders saved daily by the 17:00–17:15 Soft-Landing Grace Cutoff
 * @param {number} [params.avgOrderValueKes=650] - Average order basket size in KES
 * @param {number} [params.operatingDaysPerMonth=26] - Active kitchen days per month
 * @param {number} [params.preventedMixupBagsPerMonth=8] - Wrong-order refunds prevented by Stage 2 BAG-01 Slips
 * @param {number} [params.kitchenHoursSavedPerDay=1.0] - Prep/packing hours saved daily by Stage 1 + Stage 2 automation
 * @param {number} [params.hourlyKitchenLaborKes=250] - Value of kitchen operator time per hour in KES
 * @param {number} [params.monthlyLeaseCostKes=10500] - Total platform cost (e.g. KES 4,500 base + 600 bags * KES 10)
 * @returns {Object} Merchant ROI analysis
 */
export function calculateMerchantRoi({
  rescuedOrdersPerDay = 2,
  avgOrderValueKes = 650,
  operatingDaysPerMonth = 26,
  preventedMixupBagsPerMonth = 8,
  kitchenHoursSavedPerDay = 1.0,
  hourlyKitchenLaborKes = 250,
  monthlyLeaseCostKes = 10500
} = {}) {
  const rescuedGraceWindowRevenueKes =
    rescuedOrdersPerDay * avgOrderValueKes * operatingDaysPerMonth;
  const preventedRefundSavingsKes = preventedMixupBagsPerMonth * avgOrderValueKes;
  const laborTimeValueSavedKes =
    kitchenHoursSavedPerDay * hourlyKitchenLaborKes * operatingDaysPerMonth;

  const totalMonthlyValueCreatedKes =
    rescuedGraceWindowRevenueKes + preventedRefundSavingsKes + laborTimeValueSavedKes;

  const netMerchantGainKes = totalMonthlyValueCreatedKes - monthlyLeaseCostKes;
  const roiMultiple =
    monthlyLeaseCostKes > 0
      ? Number((totalMonthlyValueCreatedKes / monthlyLeaseCostKes).toFixed(2))
      : 0;

  return {
    rescuedGraceWindowRevenueKes,
    preventedRefundSavingsKes,
    laborTimeValueSavedKes,
    totalMonthlyValueCreatedKes,
    monthlyLeaseCostKes,
    netMerchantGainKes,
    roiMultiple
  };
}

/**
 * Projects platform-wide Monthly Recurring Revenue (MRR) and Annual Recurring Revenue (ARR)
 * across a portfolio of leased kitchen & campus food tenants.
 *
 * @param {Object} params
 * @param {number} [params.modelATenants=15] - Number of tenants on Model A (KES 2,500 base)
 * @param {number} [params.modelBProTenants=35] - Number of tenants on Model B Pro (KES 4,500 base)
 * @param {number} [params.avgOrdersPerTenant=600] - Average monthly bagged orders per tenant
 * @returns {Object} Portfolio MRR & ARR projection
 */
export function projectPortfolioRevenue({
  modelATenants = 15,
  modelBProTenants = 35,
  avgOrdersPerTenant = 600
} = {}) {
  const modelAMetrics = calculateTenantMonthlyRevenue({
    tierId: 'TIER_1_MODEL_A',
    monthlyOrders: avgOrdersPerTenant
  });
  const modelBMetrics = calculateTenantMonthlyRevenue({
    tierId: 'TIER_2_MODEL_B_PRO',
    monthlyOrders: avgOrdersPerTenant
  });

  const totalActivePaidTenants = modelATenants + modelBProTenants;
  const monthlyMrrKes =
    modelATenants * modelAMetrics.revenueBreakdownKes.totalMonthlyRevenueKes +
    modelBProTenants * modelBMetrics.revenueBreakdownKes.totalMonthlyRevenueKes;

  const annualArrKes = monthlyMrrKes * 12;
  const totalMonthlyGrossProfitKes =
    modelATenants * modelAMetrics.unitEconomics.grossProfitKes +
    modelBProTenants * modelBMetrics.unitEconomics.grossProfitKes;

  const portfolioGrossMarginPercent =
    monthlyMrrKes > 0
      ? Number(((totalMonthlyGrossProfitKes / monthlyMrrKes) * 100).toFixed(2))
      : 0;

  return {
    totalActivePaidTenants,
    modelATenants,
    modelBProTenants,
    monthlyMrrKes,
    annualArrKes,
    totalMonthlyGrossProfitKes,
    annualGrossProfitKes: totalMonthlyGrossProfitKes * 12,
    portfolioGrossMarginPercent
  };
}
