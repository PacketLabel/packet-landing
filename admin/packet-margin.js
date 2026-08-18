// ============================================================
// Packet — margin engine
// Built from the AXRIK starter kit under licence. Kit v1.1.0.
// ============================================================
// The arithmetic behind every recommendation the sourcing tool
// makes. Deliberately plain, deliberately deterministic, and
// deliberately NOT an AI feature.
//
// The AI's job in this tool is matching a supplier product to a
// competitor product when the titles do not line up, and sorting
// products into categories. Its job is not this. Money maths must
// give the same answer twice and must be arguable line by line,
// which means ordinary code that anybody can read.
//
// Everything is in PENCE, integer, throughout. No floats for money
// until the final display. Retail prices are INCLUSIVE of VAT
// because that is how a shop quotes them; trade prices are
// EXCLUSIVE because that is how a supplier quotes them. Getting
// those two the wrong way round is the classic way to build a
// margin calculator that flatters everything by twenty per cent.
//
// Loaded by the admin page directly and by build-opportunities.js
// in Node, hence the wrapper at the bottom.
// ============================================================

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PacketMargin = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------- helpers

  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  // Median, not mean. One competitor clearing stock at a silly price
  // should not drag the whole recommendation down with it.
  function median(values) {
    if (!values.length) return null;
    var s = values.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
  }

  // Round to a price a shop would actually display: nearest 50p,
  // less a penny. 847 -> 849, 1120 -> 1099, 320 -> 299.
  // This is a starting point on the screen, not a decision. The
  // human sets the real price and can type anything they like.
  function roundToRetail(pence) {
    if (!isNum(pence) || pence <= 0) return null;
    var rounded = Math.round(pence / 50) * 50;
    if (rounded < 50) rounded = 50;
    return rounded - 1;
  }

  // ---------------------------------------------------------- settings check

  // The engine refuses rather than guesses. Anything it cannot know
  // from a contract or an observation is named here and reported
  // back, so the screen can say exactly which number is missing
  // instead of silently producing a confident wrong answer.
  var REQUIRED = [
    ['vatRegistered',        'VAT registered — yes or no'],
    ['paymentFeePct',        'Payment provider percentage fee'],
    ['paymentFeeFixedPence', 'Payment provider fixed fee per transaction']
  ];

  function checkSettings(s) {
    var missing = [];
    for (var i = 0; i < REQUIRED.length; i++) {
      var key = REQUIRED[i][0];
      var v = s[key];
      if (v === null || v === undefined || (key !== 'vatRegistered' && !isNum(v))) {
        missing.push(REQUIRED[i][1]);
      }
    }
    if (s.vatRegistered === true && !isNum(s.vatRate)) missing.push('VAT rate');
    return missing;
  }

  // ---------------------------------------------------------- the engine

  // input:
  //   costPricePence       supplier trade price, EX VAT
  //   deliveryCostPence    what the supplier charges us to ship one
  //   competitorPrices     array of pence, INC VAT, from live listings
  //   weeksObserved        how long we have been watching the cheapest
  //   settings             from sourcing_settings
  //   category             from category_settings
  //   overridePricePence   a human-typed price, INC VAT (optional)
  //
  // Returns a flat object. Every intermediate figure is kept, because
  // the whole point is that a recommendation can be taken apart.
  function evaluate(input) {
    var s   = input.settings || {};
    var cat = input.category || {};

    var out = {
      ok: false,
      reasons: [],
      confidence: 'unproven',
      confidenceNotes: []
    };

    var missing = checkSettings(s);
    if (missing.length) {
      out.reasons.push('Cannot price this until these are filled in: ' + missing.join(', ') + '.');
      return out;
    }
    if (!isNum(input.costPricePence)) {
      out.reasons.push('No supplier cost price.');
      return out;
    }

    var vatRate = s.vatRegistered ? s.vatRate : 0;

    // ---- What the competitors are doing --------------------------
    var comps = (input.competitorPrices || []).filter(isNum).filter(function (p) { return p > 0; });
    out.nCompetitors         = comps.length;
    out.competitorMinPence   = comps.length ? Math.min.apply(null, comps) : null;
    out.competitorMaxPence   = comps.length ? Math.max.apply(null, comps) : null;
    out.competitorMedianPence = median(comps);

    // ---- What we would charge ------------------------------------
    var price;
    if (isNum(input.overridePricePence)) {
      price = input.overridePricePence;
      out.priceSource = 'set by hand';
    } else if (out.competitorMedianPence) {
      var adj = (s.pricePositionPct || 0) / 100;
      var factor = s.pricePosition === 'undercut' ? (1 - adj)
                 : s.pricePosition === 'premium'  ? (1 + adj)
                 : 1;
      price = roundToRetail(out.competitorMedianPence * factor);
      out.priceSource = 'competitor median, ' + (s.pricePosition || 'match');
    } else {
      out.reasons.push('No competitor price to work from, so there is nothing to anchor a price to.');
      return out;
    }
    out.suggestedPricePence = price;

    // ---- What it costs us ----------------------------------------
    // If Packet is NOT VAT registered it cannot reclaim the VAT the
    // supplier charges, so the trade price costs 20% more than the
    // headline figure. It also does not have to hand VAT over on the
    // sale. Both effects are real and they do not cancel out. This
    // is the single most commonly botched line in a margin sheet.
    var vatOnPurchases = s.vatRegistered ? 1 : (1 + (s.vatRate || 0));

    var goods    = Math.round(input.costPricePence * vatOnPurchases);
    var delivery = Math.round((input.deliveryCostPence || 0) * vatOnPurchases);
    var pickPack = s.pickPackPence || 0;

    out.landedCostPence = goods + delivery + pickPack;
    out.costBreakdown = { goods: goods, delivery: delivery, pickPack: pickPack };

    // ---- Fees ------------------------------------------------------
    // Charged on the gross amount the customer pays, VAT included.
    var paymentFee  = Math.round(price * s.paymentFeePct) + s.paymentFeeFixedPence;
    var platformFee = isNum(s.platformFeePct) ? Math.round(price * s.platformFeePct) : 0;
    out.feesPence = paymentFee + platformFee;
    out.feeBreakdown = { payment: paymentFee, platform: platformFee };

    // ---- Revenue we actually keep ----------------------------------
    var netRevenue = s.vatRegistered ? Math.round(price / (1 + vatRate)) : price;
    out.netRevenuePence = netRevenue;
    out.vatDuePence = price - netRevenue;

    // ---- Returns ---------------------------------------------------
    // Modelled conservatively and on purpose. On a dropship return
    // Packet refunds the customer in full, usually does not get a
    // credit from the supplier on cheap goods (the return carriage
    // costs more than the item), and typically does not get the
    // payment fee back either. So a returned order loses the cost,
    // the fee and the handling, and earns nothing.
    //
    //   per unit sold = revenue x (1 - r) - cost - fees - r x handling
    //
    // If a supplier will credit returns in writing, that is worth
    // more than any pricing tweak and the model should be revisited.
    var r = isNum(cat.returnRate) ? cat.returnRate : null;
    var handling = isNum(cat.returnHandlingCostPence) ? cat.returnHandlingCostPence : 0;

    if (r === null) {
      out.confidenceNotes.push(
        'No measured return rate for this category, so returns are excluded. ' +
        'Treat the margin as the best case, not the expected case.');
      r = 0;
      out.returnRateKnown = false;
    } else {
      out.returnRateKnown = true;
    }

    out.expectedReturnCostPence = Math.round(netRevenue * r + handling * r);
    out.contributionPence = Math.round(
      netRevenue * (1 - r) - out.landedCostPence - out.feesPence - handling * r
    );
    out.contributionPct = netRevenue > 0
      ? Math.round((out.contributionPence / netRevenue) * 10000) / 100
      : null;

    // ---- Advertising -----------------------------------------------
    // The line that decides whether any of this is a business. A
    // product can look healthy on contribution and be underwater the
    // moment it costs anything to find a customer.
    if (isNum(s.assumedCpaPence)) {
      out.contributionAfterAdsPence = out.contributionPence - s.assumedCpaPence;
      out.cpaPence = s.assumedCpaPence;
    } else {
      out.contributionAfterAdsPence = null;
      out.cpaPence = null;
      out.confidenceNotes.push(
        'No assumed cost per acquisition, so this is contribution BEFORE advertising. ' +
        'Advertising is what usually removes it.');
    }

    // ---- How much to trust the above -------------------------------
    if (out.returnRateKnown && isNum(s.assumedCpaPence)) {
      out.confidence = comps.length >= 3 ? 'good' : 'partial';
      if (comps.length < 3) {
        out.confidenceNotes.push(
          'Only ' + comps.length + ' competitor price' + (comps.length === 1 ? '' : 's') +
          ' to compare against. A median of one or two is not a market price.');
      }
    } else if (out.returnRateKnown || isNum(s.assumedCpaPence)) {
      out.confidence = 'partial';
    } else {
      out.confidence = 'unproven';
    }

    // ---- Does it clear the bar -------------------------------------
    var basis = isNum(out.contributionAfterAdsPence)
      ? out.contributionAfterAdsPence
      : out.contributionPence;

    out.meetsMinimum = isNum(s.minContributionPence) ? basis >= s.minContributionPence : null;
    out.meetsTarget  = isNum(s.targetContributionPct) && isNum(out.contributionPct)
      ? out.contributionPct >= s.targetContributionPct
      : null;

    // ---- Ranking ---------------------------------------------------
    // Kept deliberately simple: what we make, multiplied by how many
    // competitors bother to stock it. Number of stockists is the only
    // demand evidence available — Packet has no sales data for anyone
    // — and it is weak. A cleverer score would just be a more
    // confident guess. Weeks observed nudges it, so something four
    // shops have carried for months outranks something that appeared
    // last Tuesday.
    var weeks = isNum(input.weeksObserved) ? input.weeksObserved : 0;
    out.weeksObserved = weeks;
    out.demandSignal = Math.round(
      (comps.length * (1 + Math.min(weeks, 12) / 12)) * 100
    ) / 100;
    out.score = Math.round(Math.max(0, basis) * out.demandSignal);

    out.ok = true;
    return out;
  }

  // ---------------------------------------------------------- compliance

  // Runs before anything else is worth doing. Returns the status
  // written onto the opportunity row; the database trigger in 005
  // then refuses to let a blocked row be approved.
  //
  // Packet is legally the seller of everything it sells. If this
  // tool shortlists a cosmetic with no UK Responsible Person behind
  // it, that is Packet's problem and nobody else's.
  function complianceCheck(supplier, category) {
    supplier = supplier || {};
    category = category || {};

    if (!category.category) {
      return {
        status: 'needs_check',
        reason: 'No category set, so no compliance rule could be applied.'
      };
    }

    if (category.requires_uk_rp && !supplier.is_uk_responsible_person) {
      return {
        status: 'blocked',
        reason: 'This is applied to the body and needs a UK Responsible Person. ' +
                supplier.name + ' is not recorded as holding that role, so Packet ' +
                'cannot list it without taking on the Responsible Person burden itself.'
      };
    }

    if (category.requires_uk_rp && supplier.is_uk_responsible_person && !supplier.rp_evidence) {
      return {
        status: 'needs_check',
        reason: supplier.name + ' is marked as UK Responsible Person but no evidence ' +
                'is recorded against them. Get it in writing before listing.'
      };
    }

    if (supplier.ships_from_country && supplier.ships_from_country !== 'GB') {
      return {
        status: 'needs_check',
        reason: 'Ships from ' + supplier.ships_from_country + ', not the UK. Import VAT, ' +
                'customs and delivery times all change, and the delivery promise on the ' +
                'product page has to match.'
      };
    }

    if (category.category === 'kids') {
      return {
        status: 'needs_check',
        reason: 'Kids’ products carry toy safety duties and the highest recall ' +
                'exposure on the list. Never approve one on the strength of a margin alone.'
      };
    }

    return { status: 'ok', reason: null };
  }

  return {
    evaluate: evaluate,
    complianceCheck: complianceCheck,
    median: median,
    roundToRetail: roundToRetail,
    checkSettings: checkSettings
  };
}));
