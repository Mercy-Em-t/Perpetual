import { describe, it, expect } from 'vitest';
import {
  LEASE_PRICING_TIERS,
  INDIVIDUAL_FEATURE_ADDONS,
  calculateTenantMonthlyRevenue,
  calculateMerchantRoi,
  projectPortfolioRevenue
} from './LeaseRevenueEngine';

describe('LeaseRevenueEngine — Commercial Business Model & Revenue Calculator', () => {
  it('defines 3 distinct lease tiers with clear feature gates', () => {
    expect(LEASE_PRICING_TIERS.TIER_0_CORE.monthlyFeeKes).toBe(0);
    expect(LEASE_PRICING_TIERS.TIER_1_MODEL_A.monthlyFeeKes).toBe(2500);
    expect(LEASE_PRICING_TIERS.TIER_2_MODEL_B_PRO.monthlyFeeKes).toBe(4500);
    expect(LEASE_PRICING_TIERS.TIER_2_MODEL_B_PRO.includedFeatures).toContain(
      'customer-bag-packing-slips'
    );
  });

  it('prices individual feature add-on leases accurately', () => {
    expect(INDIVIDUAL_FEATURE_ADDONS['preorder-grace-cutoff-15m'].monthlyLeaseKes).toBe(1200);
    expect(INDIVIDUAL_FEATURE_ADDONS['customer-bag-packing-slips'].monthlyLeaseKes).toBe(1800);
  });

  it('calculates monthly tenant revenue and ~98%+ gross margin with KES 0 WhatsApp transport cost', () => {
    const result = calculateTenantMonthlyRevenue({
      tierId: 'TIER_2_MODEL_B_PRO',
      monthlyOrders: 600,
      avgOrderValueKes: 650,
      eventPassBatches: 2,
      infraCostPerTenantKes: 120
    });

    // Base: 4,500 + Bags: (600 * 10 = 6,000) + Event Passes: (2 * 150 = 300) = 10,800 KES
    expect(result.revenueBreakdownKes.baseSubscriptionLease).toBe(4500);
    expect(result.revenueBreakdownKes.bagFulfillmentMeteredFee).toBe(6000);
    expect(result.revenueBreakdownKes.eventBatchPasses).toBe(300);
    expect(result.revenueBreakdownKes.totalMonthlyRevenueKes).toBe(10800);

    // Zero WhatsApp per-message cost via Baileys WebSocket bridge
    expect(result.unitEconomics.whatsappTransportCostKes).toBe(0);
    expect(result.unitEconomics.grossProfitKes).toBe(10680);
    expect(result.unitEconomics.grossMarginPercent).toBeGreaterThan(98);
    expect(result.unitEconomics.effectivePlatformTakeRatePercent).toBeLessThan(3);
  });

  it('proves positive Merchant ROI (>4x return on lease cost) for Leah’s Kitchen', () => {
    const roi = calculateMerchantRoi({
      rescuedOrdersPerDay: 2,
      avgOrderValueKes: 650,
      operatingDaysPerMonth: 26,
      preventedMixupBagsPerMonth: 8,
      kitchenHoursSavedPerDay: 1.0,
      hourlyKitchenLaborKes: 250,
      monthlyLeaseCostKes: 10500
    });

    // Rescued GMV: 2 * 650 * 26 = 33,800
    // Prevented mixup refunds: 8 * 650 = 5,200
    // Labor saved: 1 * 250 * 26 = 6,500
    // Total Value = 45,500 vs 10,500 cost -> +35,000 net gain (4.33x ROI)
    expect(roi.rescuedGraceWindowRevenueKes).toBe(33800);
    expect(roi.preventedRefundSavingsKes).toBe(5200);
    expect(roi.laborTimeValueSavedKes).toBe(6500);
    expect(roi.totalMonthlyValueCreatedKes).toBe(45500);
    expect(roi.netMerchantGainKes).toBe(35000);
    expect(roi.roiMultiple).toBe(4.33);
  });

  it('projects multi-tenant portfolio MRR and ARR across 50 leased kitchens', () => {
    const portfolio = projectPortfolioRevenue({
      modelATenants: 15,
      modelBProTenants: 35,
      avgOrdersPerTenant: 600
    });

    // Model A tenant: 2,500 + (600 * 5) = 5,500 * 15 = 82,500
    // Model B tenant: 4,500 + (600 * 10) = 10,500 * 35 = 367,500
    // Total MRR = 450,000 KES/mo | ARR = 5,400,000 KES/yr
    expect(portfolio.totalActivePaidTenants).toBe(50);
    expect(portfolio.monthlyMrrKes).toBe(450000);
    expect(portfolio.annualArrKes).toBe(5400000);
    expect(portfolio.portfolioGrossMarginPercent).toBeGreaterThan(98);
  });
});
