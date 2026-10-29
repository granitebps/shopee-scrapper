/**
 * Offline unit tests for pure helpers — no browser, no login, no network.
 * Unlike test/smoke.ts (live), this is safe to run in CI on every push.
 *
 * Run with: npm run test:unit
 */
import assert from 'node:assert/strict';
import { flattenSearchItems } from '../src/tools/search.js';
import { formatPrice } from '../src/utils/price.js';
import {
  parseProductUrl,
  priceText,
  resolveProductIds,
  specLines,
  shippingLines,
  sellerLines,
} from '../src/tools/product.js';
import { buildSearchPath } from '../src/tools/search.js';
import { starBreakdown, formatReview } from '../src/tools/reviews.js';
import { formatDuration, formatShop } from '../src/tools/shop.js';
import { collectFlashItems, flashStockText, formatTime } from '../src/tools/flashsale.js';
import { formatCart, modelOptionLabels, findCartItem } from '../src/tools/cart.js';
import {
  humanizeLabel,
  collectOrders,
  formatOrder,
  formatOrderDetail,
  voucherBenefit,
  decodeNotificationText,
  formatNotification,
} from '../src/tools/account.js';
import { shopVouchersFrom, formatShopVouchers } from '../src/tools/actions.js';
import { createIdleCloser, idleMsFrom, DEFAULT_IDLE_MS } from '../src/browser/idle.js';
import {
  accountToolsSetting,
  registerAccountTool,
  setLoggedIn,
  accountModeActive,
  refreshAccountMode,
  initAccountMode,
} from '../src/account-mode.js';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildVariantRows } from '../src/tools/variants.js';
import { shopeeCapture, requireLogin, ShopeeAuthRequiredError } from '../src/api/client.js';
import { cache } from '../src/utils/cache.js';
import { regionFor } from '../src/browser/session.js';
import type { SearchItem, ItemBasic, PdpModel, PdpItem, Rating } from '../src/api/types.js';

let failures = 0;
const pending: Array<{ name: string; fn: () => void | Promise<void> }> = [];

function test(name: string, fn: () => void | Promise<void>): void {
  pending.push({ name, fn });
}

async function runTests(): Promise<void> {
  for (const { name, fn } of pending) {
    try {
      await fn();
      console.log(`✅ ${name}`);
    } catch (err) {
      failures++;
      console.log(`❌ ${name}`);
      console.log(`   ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function fakeItemBasic(overrides: Partial<ItemBasic> = {}): ItemBasic {
  return {
    itemid: 1,
    shopid: 1,
    name: 'Test Product',
    price: 1000000,
    price_min: 1000000,
    price_max: 1000000,
    price_before_discount: 0,
    currency: 'IDR',
    stock: 10,
    sold: 5,
    historical_sold: 5,
    liked_count: 0,
    item_rating: { rating_star: 4.5, rating_count: [] },
    shop_location: 'Jakarta',
    is_official_shop: false,
    shopee_verified: false,
    image: '',
    ...overrides,
  };
}

/** A newer card-shaped result, as observed live on shopee.com.my. */
function fakeCard(overrides: Partial<SearchItem> = {}): SearchItem {
  return {
    itemid: 43174409162,
    shopid: 1432004273,
    item_basic: null as unknown as ItemBasic,
    item_data: {
      item_card_display_price: {
        price: 22555000,
        strikethrough_price: 47806000,
        original_price: 47806000,
        discount: 53,
      },
      item_card_display_sold_count: {
        historical_sold_count: 23758,
        monthly_sold_count: 19370,
        historical_sold_count_text: '20k+ sold',
      },
      item_rating: { rating_star: 4.97, rating_count: [] },
      shop_data: { shop_name: 'Ugreen Official Shop' },
      shopee_verified: false,
    },
    item_card_displayed_asset: {
      name: 'Ugreen Nexode Power Bank 20000mAh 130W',
      image: 'cn-11134207',
      shop_location: 'Selangor',
    },
    ...overrides,
  };
}

// ─── flattenSearchItems: legacy item_basic shape (the #25 fix) ─────────────

test('flattenSearchItems: normalises plain cards with item_basic', () => {
  const b = fakeItemBasic({ itemid: 1, name: 'Legacy', shop_location: 'Jakarta' });
  const items: SearchItem[] = [{ itemid: 1, shopid: 1, item_basic: b }];
  const [r] = flattenSearchItems(items);
  assert.equal(r.name, 'Legacy');
  assert.equal(r.price, 1000000);
  assert.equal(r.currency, 'IDR');
  assert.equal(r.shopLocation, 'Jakarta');
  assert.equal(r.ratingStar, 4.5);
});

test('flattenSearchItems: flattens a recommendation/ads card with real_items', () => {
  // Reproduces the exact crash from #25: a card with no top-level item_basic,
  // whose real products are nested under real_items.
  const b1 = fakeItemBasic({ itemid: 1 });
  const b2 = fakeItemBasic({ itemid: 2 });
  const adsCard = {
    itemid: 0,
    shopid: 0,
    item_basic: null as unknown as ItemBasic,
    real_items: [{ item_basic: b1 }, { item_basic: b2 }],
  };
  assert.deepEqual(
    flattenSearchItems(adsCard ? [adsCard] : []).map((r) => r.itemid),
    [1, 2],
  );
});

test('flattenSearchItems: mixes plain and ads cards in order', () => {
  const plain = fakeItemBasic({ itemid: 1 });
  const nested = fakeItemBasic({ itemid: 2 });
  const items = [
    { itemid: 1, shopid: 1, item_basic: plain },
    {
      itemid: 0,
      shopid: 0,
      item_basic: null as unknown as ItemBasic,
      real_items: [{ item_basic: nested }],
    },
  ];
  assert.deepEqual(
    flattenSearchItems(items).map((r) => r.itemid),
    [1, 2],
  );
});

test('flattenSearchItems: drops a card with neither item_basic nor real_items', () => {
  const dead = { itemid: 0, shopid: 0, item_basic: null as unknown as ItemBasic };
  assert.deepEqual(flattenSearchItems([dead]), []);
});

test('flattenSearchItems: drops null item_basic entries nested in real_items', () => {
  const good = fakeItemBasic({ itemid: 1 });
  const card = {
    itemid: 0,
    shopid: 0,
    item_basic: null as unknown as ItemBasic,
    real_items: [{ item_basic: good }, { item_basic: null as unknown as ItemBasic }],
  };
  assert.deepEqual(
    flattenSearchItems([card]).map((r) => r.itemid),
    [1],
  );
});

test('flattenSearchItems: handles null/undefined items list', () => {
  assert.deepEqual(flattenSearchItems(null), []);
  assert.deepEqual(flattenSearchItems(undefined), []);
});

// ─── flattenSearchItems: newer card shape (shopee.com.my) ──────────────────

test('flattenSearchItems: reads a newer card with item_basic null', () => {
  const [r] = flattenSearchItems([fakeCard()]);
  assert.equal(r.name, 'Ugreen Nexode Power Bank 20000mAh 130W');
  assert.equal(r.itemid, 43174409162);
  assert.equal(r.shopid, 1432004273);
  assert.equal(r.price, 22555000);
  assert.equal(r.priceBeforeDiscount, 47806000);
  assert.equal(r.ratingStar, 4.97);
  assert.equal(r.shopLocation, 'Selangor');
});

test('flattenSearchItems: prefers Shopee pre-formatted sold text on newer cards', () => {
  const [r] = flattenSearchItems([fakeCard()]);
  assert.equal(r.soldText, '20k+ sold');
  assert.equal(r.sold, 23758);
});

test('flattenSearchItems: leaves currency undefined on newer cards', () => {
  // Newer cards carry no currency field; the caller falls back to the region's.
  const [r] = flattenSearchItems([fakeCard()]);
  assert.equal(r.currency, undefined);
});

test('flattenSearchItems: a newer card with real_items stays one product', () => {
  // real_items on a newer card describes the SAME product, not extra ones —
  // fanning it out would emit a duplicate per entry.
  const card = fakeCard({
    real_items: [
      { item_id: 24782704787, shop_id: 64923440, info: 'AB:711473|...' },
    ] as unknown as SearchItem['real_items'],
  });
  assert.equal(flattenSearchItems([card]).length, 1);
});

test('flattenSearchItems: virtual cards resolve identity from real_items', () => {
  // Some newer cards are "virtual item" placeholders: the top-level ids are a
  // synthetic selection model that pdp/get_pc rejects with 266900504. The real
  // purchasable listing is in real_items[0] — use that for links and lookups.
  const card = fakeCard({
    itemid: 43174409162,
    shopid: 1432004273,
    real_items: [
      { item_id: 24782704787, shop_id: 64923440, info: 'AB:711473|...' },
    ] as unknown as SearchItem['real_items'],
  });
  const [r] = flattenSearchItems([card]);
  assert.equal(r.itemid, 24782704787, 'should use the real item id');
  assert.equal(r.shopid, 64923440, 'should use the real shop id');
  // Display still comes from the card the user actually sees.
  assert.equal(r.name, 'Ugreen Nexode Power Bank 20000mAh 130W');
  assert.equal(r.price, 22555000);
});

test('flattenSearchItems: a newer card without real_items keeps its own ids', () => {
  const [r] = flattenSearchItems([fakeCard()]);
  assert.equal(r.itemid, 43174409162);
  assert.equal(r.shopid, 1432004273);
});

test('flattenSearchItems: drops a newer card missing a name or price', () => {
  const noName = fakeCard({ item_card_displayed_asset: { name: '', shop_location: 'Selangor' } });
  assert.deepEqual(flattenSearchItems([noName]), []);
  const noPrice = fakeCard({ item_data: { item_card_display_price: null } });
  assert.deepEqual(flattenSearchItems([noPrice]), []);
});

test('flattenSearchItems: handles a response mixing both shapes', () => {
  const legacy = { itemid: 1, shopid: 1, item_basic: fakeItemBasic({ itemid: 1 }) };
  const out = flattenSearchItems([legacy, fakeCard()]);
  assert.deepEqual(
    out.map((r) => r.itemid),
    [1, 43174409162],
  );
});

// ─── formatPrice ────────────────────────────────────────────────────────────

test('formatPrice: divides by 100000 and formats IDR with Rp prefix', () => {
  assert.equal(formatPrice(15000000000), 'Rp150.000');
});

test('formatPrice: rounds fractional amounts', () => {
  assert.equal(formatPrice(15000050000), 'Rp150.001');
});

test('formatPrice: renders MYR with RM and two decimals', () => {
  // RM225.55 — rounding to whole units here would silently drop sen.
  assert.equal(formatPrice(22555000, 'MYR'), 'RM225.55');
});

test('formatPrice: renders SGD with S$ and two decimals', () => {
  assert.equal(formatPrice(1999000, 'SGD'), 'S$19.99');
});

test('formatPrice: renders TWD with NT$ and no decimals', () => {
  assert.equal(formatPrice(50000000, 'TWD'), 'NT$500');
});

test('formatPrice: falls back to "CURRENCY amount" for an unmapped currency', () => {
  assert.equal(formatPrice(500000000, 'USD'), 'USD 5.000');
});

// ─── buildVariantRows ───────────────────────────────────────────────────────

/** Models as returned for the UGREEN Nexode listing (shop 331309804). */
function fakeModels(): PdpModel[] {
  return [
    {
      model_id: 139145426356,
      name: '200w 25 000mAh',
      price: 26900000,
      price_before_discount: 74750000,
      stock: null,
      has_stock: true,
      extinfo: { tier_index: [0], is_pre_order: false },
    },
    {
      model_id: 139145426358,
      name: '100w 12 000mAh',
      price: 18209000,
      price_before_discount: 42250000,
      stock: null,
      has_stock: false,
      extinfo: { tier_index: [2], is_pre_order: true },
    },
  ];
}

test('buildVariantRows: maps model id, name and prices', () => {
  const [a, b] = buildVariantRows(fakeModels());
  assert.equal(a.modelId, 139145426356);
  assert.equal(a.name, '200w 25 000mAh');
  assert.equal(a.price, 26900000);
  assert.equal(a.priceBeforeDiscount, 74750000);
  assert.equal(b.modelId, 139145426358);
});

test('buildVariantRows: falls back to has_stock when no counts were gathered', () => {
  // get_pc leaves numeric stock null, so availability is all we can report.
  const [a, b] = buildVariantRows(fakeModels());
  assert.equal(a.stock, undefined);
  assert.equal(a.inStock, true);
  assert.equal(b.inStock, false);
});

test('buildVariantRows: folds in exact counts keyed by variant name', () => {
  const stock = new Map([
    ['200w 25 000mAh', 229],
    ['100w 12 000mAh', 244],
  ]);
  const [a, b] = buildVariantRows(fakeModels(), stock);
  assert.equal(a.stock, 229);
  assert.equal(b.stock, 244);
});

test('buildVariantRows: a variant missing from the stock map keeps availability only', () => {
  // Clicking can fail for one option without invalidating the rest.
  const [a, b] = buildVariantRows(fakeModels(), new Map([['200w 25 000mAh', 229]]));
  assert.equal(a.stock, 229);
  assert.equal(b.stock, undefined);
  assert.equal(b.inStock, false);
});

test('buildVariantRows: zero stock is reported, not treated as missing', () => {
  const [a] = buildVariantRows(fakeModels(), new Map([['200w 25 000mAh', 0]]));
  assert.equal(a.stock, 0, '0 must survive — a sold-out count is real data');
});

test('buildVariantRows: carries the pre-order flag', () => {
  const [a, b] = buildVariantRows(fakeModels());
  assert.equal(a.isPreOrder, false);
  assert.equal(b.isPreOrder, true);
});

test('buildVariantRows: handles a listing with no models', () => {
  assert.deepEqual(buildVariantRows(null), []);
  assert.deepEqual(buildVariantRows(undefined), []);
  assert.deepEqual(buildVariantRows([]), []);
});

// ─── priceText (product detail) ─────────────────────────────────────────────

test('priceText: formats a single MYR price with the shared currency table', () => {
  // Regression: the product tool used to format every non-IDR price with
  // Indonesian rules, rendering RM163.03 as "MYR 163,03".
  assert.equal(
    priceText({ single_value: 16303000, range_min: -1, range_max: -1 }, 'MYR'),
    'RM163.03',
  );
});

test('priceText: formats an IDR price unchanged', () => {
  assert.equal(
    priceText({ single_value: 15000000000, range_min: -1, range_max: -1 }, 'IDR'),
    'Rp150.000',
  );
});

test('priceText: renders a range when min and max differ', () => {
  assert.equal(
    priceText({ single_value: 0, range_min: 1000000, range_max: 2500000 }, 'MYR'),
    'RM10.00 – RM25.00',
  );
});

test('priceText: treats a -1 range as a single price', () => {
  assert.equal(
    priceText({ single_value: 5000000, range_min: -1, range_max: -1 }, 'SGD'),
    'S$50.00',
  );
});

// ─── parseProductUrl ────────────────────────────────────────────────────────

test('parseProductUrl: parses /product/<shopid>/<itemid> form', () => {
  assert.deepEqual(parseProductUrl('https://shopee.co.id/product/78730497/47060432055'), {
    shopId: '78730497',
    itemId: '47060432055',
  });
});

test('parseProductUrl: parses "-i.<shopid>.<itemid>" slug form', () => {
  assert.deepEqual(
    parseProductUrl('https://shopee.co.id/Some-Product-Name-i.78730497.47060432055'),
    { shopId: '78730497', itemId: '47060432055' },
  );
});

test('parseProductUrl: returns null for an unrelated URL', () => {
  assert.equal(parseProductUrl('https://shopee.co.id/'), null);
});

// ─── cache ──────────────────────────────────────────────────────────────────

test('cache: set/get round-trips within TTL', () => {
  cache.set('unit-test-key', 'value');
  assert.equal(cache.get('unit-test-key'), 'value');
});

test('cache: get returns undefined for a missing key', () => {
  assert.equal(cache.get('never-set-key'), undefined);
});

test('cache: key() joins parts with ":"', () => {
  assert.equal(cache.key('search', 'shoes', 1, 20, 'relevance'), 'search:shoes:1:20:relevance');
});

// ─── regionFor (locale/timezone by domain) ──────────────────────────────────

test('regionFor: .id domains get Indonesian locale/timezone/currency', () => {
  assert.deepEqual(regionFor('shopee.co.id'), {
    locale: 'id-ID',
    timezone: 'Asia/Jakarta',
    currency: 'IDR',
  });
});

test('regionFor: .my domains get Malaysian locale/timezone/currency', () => {
  assert.deepEqual(regionFor('shopee.com.my'), {
    locale: 'en-MY',
    timezone: 'Asia/Kuala_Lumpur',
    currency: 'MYR',
  });
});

test('regionFor: .sg domains get Singaporean locale/timezone/currency', () => {
  assert.deepEqual(regionFor('shopee.sg'), {
    locale: 'en-SG',
    timezone: 'Asia/Singapore',
    currency: 'SGD',
  });
});

test('regionFor: .tw domains get Taiwanese locale/timezone/currency', () => {
  assert.deepEqual(regionFor('shopee.tw'), {
    locale: 'zh-TW',
    timezone: 'Asia/Taipei',
    currency: 'TWD',
  });
});

test('regionFor: an unmapped domain falls back to the Indonesian defaults', () => {
  assert.deepEqual(regionFor('shopee.vn'), {
    locale: 'id-ID',
    timezone: 'Asia/Jakarta',
    currency: 'IDR',
  });
});

test('regionFor: matches on the TLD suffix, not a substring elsewhere', () => {
  // ".my" appears mid-string but the TLD is .tw — must not match Malaysia.
  assert.equal(regionFor('shopee.my-mirror.tw').currency, 'TWD');
});

// ─── shopeeCapture retry-on-timeout ─────────────────────────────────────────

const loggedIn = async () => true;
const loggedOut = async () => false;

test('shopeeCapture: recovers from a single timeout via retry, no auth error', async () => {
  let calls = 0;
  const flakyCapture = async () => {
    calls++;
    if (calls === 1) throw new Error('Timeout 30000ms exceeded');
    return { error: 0, items: [] };
  };
  const result = await shopeeCapture(
    'https://x',
    'search/search_items',
    undefined,
    false,
    flakyCapture,
    loggedIn,
  );
  assert.equal(calls, 2);
  assert.deepEqual(result, { error: 0, items: [] });
});

test('shopeeCapture: reports auth-required only after a second consecutive timeout', async () => {
  let calls = 0;
  const alwaysTimesOut = async () => {
    calls++;
    throw new Error('Timeout 30000ms exceeded');
  };
  await assert.rejects(
    () =>
      shopeeCapture('https://x', 'search/search_items', undefined, false, alwaysTimesOut, loggedIn),
    ShopeeAuthRequiredError,
  );
  assert.equal(calls, 2);
});

test('shopeeCapture: signed out fails fast, without spending the capture budget', async () => {
  // The whole point: a logged-out user must get the login prompt immediately
  // rather than after a timeout (plus retry) that outlives the client's patience.
  let calls = 0;
  const capture = async () => {
    calls++;
    return { error: 0 };
  };
  await assert.rejects(
    () => shopeeCapture('https://x', 'search/search_items', undefined, false, capture, loggedOut),
    ShopeeAuthRequiredError,
  );
  assert.equal(calls, 0);
});

test('shopeeCapture: a session that lapses mid-request skips the retry', async () => {
  let calls = 0;
  const alwaysTimesOut = async () => {
    calls++;
    throw new Error('Timeout 60000ms exceeded');
  };
  // Logged in at the pre-flight check, signed out by the time it times out.
  let checks = 0;
  const lapses = async () => ++checks === 1;
  await assert.rejects(
    () =>
      shopeeCapture('https://x', 'search/search_items', undefined, false, alwaysTimesOut, lapses),
    ShopeeAuthRequiredError,
  );
  assert.equal(calls, 1, 'should not retry once the session is gone');
});

// ─── search filters ──────────────────────────────────────────────────────────

test('buildSearchPath: plain query maps sort and zero-based page', () => {
  const qs = new URLSearchParams(buildSearchPath('laptop', 2, 'price_low').split('?')[1]);
  assert.equal(qs.get('keyword'), 'laptop');
  assert.equal(qs.get('page'), '1');
  assert.equal(qs.get('sortBy'), 'price');
  assert.equal(qs.get('order'), 'asc');
  assert.equal(qs.get('minPrice'), null);
});

test('buildSearchPath: filters become the search page’s own params', () => {
  const path = buildSearchPath('keyboard', 1, 'relevance', {
    minPrice: 200000,
    maxPrice: 500000,
    minRating: 4,
    location: 'DKI Jakarta',
    officialMallOnly: true,
  });
  const qs = new URLSearchParams(path.split('?')[1]);
  assert.equal(qs.get('minPrice'), '200000');
  assert.equal(qs.get('maxPrice'), '500000');
  assert.equal(qs.get('ratingFilter'), '4');
  assert.equal(qs.get('locations'), 'DKI Jakarta');
  assert.equal(qs.get('officialMall'), 'true');
});

test('buildSearchPath: officialMallOnly=false adds no param', () => {
  assert.ok(
    !buildSearchPath('x', 1, 'relevance', { officialMallOnly: false }).includes('officialMall'),
  );
});

// ─── product detail enrichment ───────────────────────────────────────────────

test('resolveProductIds: prefers explicit ids, falls back to the URL', () => {
  assert.deepEqual(resolveProductIds('1', '2', 'https://shopee.co.id/product/3/4'), {
    shopId: '1',
    itemId: '2',
  });
  assert.deepEqual(resolveProductIds(undefined, '2', 'https://shopee.co.id/product/3/4'), {
    shopId: '3',
    itemId: '4',
  });
  assert.equal(resolveProductIds(), null);
});

test('specLines: keeps real specs, drops synthetic rows and "-" blanks', () => {
  const lines = specLines([
    { name: 'Discount stock', value: 'IN STOCK', id: null },
    { name: 'Brand', value: '-', id: 1 },
    { name: 'Material', value: 'Synthetic', id: 100134 },
  ]);
  assert.deepEqual(lines, ['  • Material: Synthetic']);
});

test('shippingLines: origin, fee range, free-shipping threshold and delivery estimate', () => {
  const lines = shippingLines(
    {
      free_shipping: {
        has_fss: true,
        min_spend: { single_value: 15000000000, range_min: -1, range_max: -1 },
      },
      shipping_fee_info: {
        ship_from_location: 'KAB. BANDUNG',
        price: { single_value: -1, range_min: 0, range_max: 1500000000 },
      },
      ungrouped_channel_infos: [
        { name: 'Reguler', channel_delivery_info: { edt_text: 'Guaranteed to get by 1 Oct' } },
      ],
    },
    'IDR',
  );
  assert.deepEqual(lines, [
    '  📍 Ships from: KAB. BANDUNG',
    '  💸 Shipping fee: Rp0 – Rp15.000',
    '  🚚 Free shipping on orders over Rp150.000',
    '  🕒 Reguler: Guaranteed to get by 1 Oct',
  ]);
});

test('shippingLines: nothing to say without a shipping block', () => {
  assert.deepEqual(shippingLines(undefined, 'IDR'), []);
});

test('sellerLines: badges, stats and a vacation warning', () => {
  const lines = sellerLines({
    shopid: 9,
    name: 'Doclo.id',
    rating_star: 4.71,
    response_rate: 79,
    follower_count: 2634,
    is_shopee_verified: true,
    vacation: true,
  });
  assert.equal(lines[0], '  🏪 Doclo.id [Verified] — Shop ID `9`');
  assert.equal(lines[1], '  ⭐ 4.7 | 💬 79% response | 👥 2.634 followers');
  assert.ok(lines[2].includes('vacation'));
});

// ─── reviews ─────────────────────────────────────────────────────────────────

test('starBreakdown: lists 5★ first from Shopee’s 1★..5★ array', () => {
  assert.equal(
    starBreakdown({ rating_total: 10, rating_count: [1, 2, 3, 4, 1000] }),
    '5★ 1.000 · 4★ 4 · 3★ 3 · 2★ 2 · 1★ 1',
  );
});

function fakeRating(overrides: Partial<Rating> = {}): Rating {
  return {
    cmtid: 1,
    rating_star: 4,
    comment: 'Bagus\nsekali',
    author_username: 'buyer1',
    anonymous: false,
    ctime: 1771988322,
    like_count: 3,
    images: ['a', 'b'],
    videos: [{}],
    product_items: [{ model_name: 'Red,M' }],
    ...overrides,
  };
}

test('formatReview: stars, author, date, variant, media and likes', () => {
  const [head, body] = formatReview(fakeRating(), 7).split('\n');
  assert.equal(head, '7. ★★★★☆ | buyer1 | 2026-02-25 | variant: Red,M | 📷 3 | 👍 3');
  assert.equal(body, '   Bagus sekali');
});

test('formatReview: hides the name of anonymous reviewers', () => {
  assert.ok(formatReview(fakeRating({ anonymous: true }), 1).includes('| Anonymous |'));
});

test('formatReview: includes the seller reply and marks empty comments', () => {
  const out = formatReview(
    fakeRating({ comment: '', ItemRatingReply: { comment: 'Terima kasih!' } }),
    1,
  );
  assert.ok(out.includes('(no written comment)'));
  assert.ok(out.includes('↳ Seller: Terima kasih!'));
});

// ─── shops ───────────────────────────────────────────────────────────────────

test('formatDuration: minutes, hours, days — without "60 min"', () => {
  assert.equal(formatDuration(20), '1 min');
  assert.equal(formatDuration(600), '10 min');
  assert.equal(formatDuration(3570), '1 h');
  assert.equal(formatDuration(3 * 86400), '3 days');
});

test('formatShop: badges, stats and profile link by username', () => {
  const now = 1790684086 * 1000 + 240 * 1000;
  const text = formatShop(
    {
      shopid: 1166009254,
      name: 'Royal Kludge Official Shop',
      account: { username: 'royalkludge_official' },
      is_official_shop: true,
      rating_star: 4.927,
      item_count: 128,
      follower_count: 9830,
      response_rate: 93,
      response_time: 3570,
      ctime: 1705363200,
      last_active_time: 1790684086,
    },
    now,
  );
  assert.ok(text.startsWith('🏪 **Royal Kludge Official Shop** [Shopee Mall]'));
  assert.ok(text.includes('⭐ Shop rating: 4.93'));
  assert.ok(text.includes('💬 Chat response: 93% (within ~1 h)'));
  assert.ok(text.includes('📅 Joined: 2024-01-16'));
  assert.ok(text.includes('🕒 Last active: 4 min ago'));
  assert.ok(text.includes('/royalkludge_official'));
  assert.ok(!text.includes('\n\n\n'), 'no doubled blank lines from omitted rows');
});

// ─── flash sale ──────────────────────────────────────────────────────────────

test('collectFlashItems: merges batches and drops duplicates and other calls', () => {
  const batch = (ids: number[]) => ({
    url: 'https://shopee.co.id/api/v4/flash_sale/flash_sale_batch_get_items',
    postData: '',
    json: {
      data: { items: ids.map((id) => ({ itemid: id, shopid: 1, name: `#${id}`, price: 1 })) },
    },
  });
  const items = collectFlashItems([
    batch([1, 2]),
    { url: 'https://shopee.co.id/api/v4/flash_sale/get_all_sessions', postData: '', json: {} },
    batch([2, 3]),
  ]);
  assert.deepEqual(
    items.map((i) => i.itemid),
    [1, 2, 3],
  );
});

test('flashStockText: claimed vs. allocated, and sold out', () => {
  const base = { itemid: 1, shopid: 1, name: 'x', price: 1 };
  assert.equal(flashStockText({ ...base, stock: 593, flash_sale_stock: 600 }), '📦 7/600 claimed');
  assert.equal(flashStockText({ ...base, stock: 0, flash_sale_stock: 600 }), '🔥 Sold out');
  assert.equal(flashStockText(base), '');
});

test('formatTime: renders in the given storefront timezone', () => {
  // 2026-09-29 11:00 UTC is 18:00 in Jakarta.
  assert.ok(formatTime(1790679600, 'Asia/Jakarta').includes('18:00'));
});

// ─── experimental cart ───────────────────────────────────────────────────────

test('formatCart: groups by shop and totals quantity × price', () => {
  const text = formatCart(
    [
      {
        shops: [{ shopid: 1, shopname: 'Toko A' }],
        items: [
          {
            itemid: 10,
            shopid: 1,
            modelid: 5,
            name: 'Kaos',
            model_name: 'Hitam',
            price: 5000000,
            quantity: 2,
          },
        ],
      },
      { shops: [{ shopid: 2, shopname: 'Empty' }], items: [] },
    ],
    'IDR',
  );
  assert.ok(text.startsWith('🛒 **Shopee Cart** — 2 items, Rp100 before vouchers & shipping'));
  assert.ok(text.includes('🏪 **Toko A**'));
  assert.ok(text.includes('• Kaos (Hitam)'));
  assert.ok(text.includes('2 × Rp50 | model_id: `5`'));
  assert.ok(!text.includes('Empty'));
});

test('formatCart: an empty cart says so', () => {
  assert.equal(formatCart([], 'IDR'), '🛒 Your Shopee cart is empty.');
});

test('modelOptionLabels: maps a model’s tier indexes to option labels', () => {
  const item = {
    item_id: 1,
    shop_id: 1,
    title: 't',
    tier_variations: [
      { name: 'Warna', options: ['Merah', 'Biru'] },
      { name: 'Ukuran', options: ['M', 'L'] },
    ],
  } as PdpItem;
  const model = {
    model_id: 9,
    name: 'Biru,L',
    price: 1,
    extinfo: { tier_index: [1, 1] },
  } as PdpModel;
  assert.deepEqual(modelOptionLabels(item, model), ['Biru', 'L']);
});

test('modelOptionLabels: null when the indexes don’t line up with the tiers', () => {
  const item = {
    item_id: 1,
    shop_id: 1,
    title: 't',
    tier_variations: [{ name: 'Warna', options: ['Merah'] }],
  } as PdpItem;
  const model = { model_id: 9, name: 'x', price: 1, extinfo: { tier_index: [3] } } as PdpModel;
  assert.equal(modelOptionLabels(item, model), null);
});

test('modelOptionLabels: a listing without variants needs no clicks', () => {
  const item = { item_id: 1, shop_id: 1, title: 't' } as PdpItem;
  assert.deepEqual(modelOptionLabels(item, { model_id: 1, name: '', price: 1 }), []);
});

test('requireLogin: throws the login prompt error when signed out', async () => {
  await requireLogin(async () => true);
  await assert.rejects(() => requireLogin(async () => false), ShopeeAuthRequiredError);
});

// ─── account mode ────────────────────────────────────────────────────────────

test('accountToolsSetting: defaults to auto, "off"/"false"/"0" turn it off', () => {
  assert.equal(accountToolsSetting(undefined), 'auto');
  assert.equal(accountToolsSetting('auto'), 'auto');
  assert.equal(accountToolsSetting('OFF'), 'off');
  assert.equal(accountToolsSetting('false'), 'off');
  assert.equal(accountToolsSetting('0'), 'off');
});

test('account mode: tools start hidden, show on login, hide on logout', async () => {
  const tool = { enabled: true } as RegisteredTool;
  setLoggedIn(false);
  registerAccountTool(tool);
  assert.equal(tool.enabled, false, 'hidden until a login is confirmed');
  await refreshAccountMode(async () => true);
  assert.equal(tool.enabled, true);
  assert.equal(accountModeActive(), true);
  await refreshAccountMode(async () => {
    throw new Error('browser died');
  });
  assert.equal(tool.enabled, false, 'a failed check falls back to read-only');
});

test('account mode: every server is toggled and notified until released', () => {
  setLoggedIn(false);
  const notified: string[] = [];
  const fakeServer = (name: string) =>
    ({ sendToolListChanged: () => notified.push(name) }) as unknown as McpServer;
  const releaseA = initAccountMode(fakeServer('a'));
  const toolA = { enabled: true } as RegisteredTool;
  registerAccountTool(toolA);
  const releaseB = initAccountMode(fakeServer('b'));
  const toolB = { enabled: true } as RegisteredTool;
  registerAccountTool(toolB);
  assert.equal(toolA.enabled, false);
  assert.equal(toolB.enabled, false);

  setLoggedIn(true);
  assert.deepEqual([toolA.enabled, toolB.enabled], [true, true]);
  assert.deepEqual(notified.sort(), ['a', 'b']);

  // A released server (e.g. a finished HTTP request) is no longer tracked.
  releaseA();
  notified.length = 0;
  setLoggedIn(false);
  assert.equal(toolA.enabled, true, 'released tools are left alone');
  assert.equal(toolB.enabled, false);
  assert.deepEqual(notified, ['b']);
  releaseB();
});

// ─── account reads ───────────────────────────────────────────────────────────

test('humanizeLabel: turns Shopee translation keys into words', () => {
  assert.equal(humanizeLabel('label_order_completed'), 'Order completed');
  assert.equal(humanizeLabel('label_cancelled'), 'Cancelled');
  assert.equal(humanizeLabel(undefined), 'Unknown');
});

const fakeOrder = (id: number) => ({
  status: { list_view_status_label: { text: 'label_completed' } },
  info_card: {
    order_id: id,
    final_total: 58900000000,
    order_list_cards: [
      {
        shop_info: { shop_id: 1, shop_name: 'iconcomp' },
        product_info: {
          item_groups: [
            {
              items: [
                {
                  item_id: 5,
                  shop_id: 1,
                  name: 'NVME 256GB',
                  model_name: 'Hitam',
                  amount: 1,
                  order_price: 65000000000,
                },
              ],
            },
          ],
        },
      },
    ],
  },
});

test('collectOrders: reads both list shapes and de-duplicates across pages', () => {
  const orders = collectOrders([
    {
      url: 'x/get_all_order_and_checkout_list',
      postData: '',
      json: {
        new_data: {
          order_or_checkout_data: [
            { order_list_detail: fakeOrder(1) },
            { order_list_detail: fakeOrder(2) },
          ],
        },
      },
    },
    {
      url: 'x/get_order_list',
      postData: '',
      json: { data: { details_list: [fakeOrder(2), fakeOrder(3)] } },
    },
  ]);
  assert.deepEqual(
    orders.map((o) => o.info_card?.order_id),
    [1, 2, 3],
  );
});

test('formatOrder: status, shop, items and total', () => {
  const out = formatOrder(fakeOrder(7), 1);
  assert.ok(out.startsWith('1. **Order `7`** — Completed'));
  assert.ok(out.includes('🏪 iconcomp'));
  assert.ok(out.includes('• NVME 256GB (Hitam) × 1 — Rp650.000'));
  assert.ok(out.includes('💰 Total: Rp589.000'));
});

test('formatOrderDetail: timeline and tracking, never the address or phone', () => {
  const detail = {
    status: { status_label: { text: 'label_order_completed' } },
    pc_shipping: {
      fulfilment_carrier: { text: 'Anteraja Sameday' },
      forder_shipping_info_list: [
        {
          tracking_number: 'TRK1',
          tracking_info_list: [{ ctime: 1788430222, description: 'Delivered.' }],
        },
      ],
    },
    info_card: { final_total: 58900000000, currency: 'IDR', parcel_cards: [] },
    payment_method: { payment_channel_name: { text: 'QRIS' } },
    pc_processing_info: {
      order_sn: 'SN1',
      create_time: 1788399955,
      complete_time: 1788630439,
      is_rated: false,
    },
    address: {
      shipping_name: 'Secret Name',
      shipping_phone: '628000',
      shipping_address: 'Jalan Rahasia 1',
    },
  };
  const out = formatOrderDetail('9', detail as Parameters<typeof formatOrderDetail>[1]);
  assert.ok(out.includes('Order completed'));
  assert.ok(out.includes('Courier: Anteraja Sameday'));
  assert.ok(out.includes('Tracking no.: TRK1'));
  assert.ok(out.includes('💳 Payment: QRIS'));
  assert.ok(out.includes('Ordered:'));
  for (const secret of ['Secret Name', '628000', 'Jalan Rahasia']) {
    assert.ok(!out.includes(secret), `leaked ${secret}`);
  }
});

test('voucherBenefit: fixed, percentage with cap, and coin cashback', () => {
  assert.equal(voucherBenefit({ discount_value: 1000000000 }, 'IDR'), 'Rp10.000 off');
  assert.equal(
    voucherBenefit({ discount_percentage: 8, discount_cap: 100000000000 }, 'IDR'),
    '8% off (max Rp1.000.000)',
  );
  assert.equal(
    voucherBenefit({ reward_percentage: 10, reward_cap: 2500000 }, 'IDR'),
    '10% coins cashback (max 25 coins)',
  );
});

test('decodeNotificationText: hex UTF-8 with HTML stripped; plain text passes through', () => {
  const hex = Buffer.from('Toko <b>Blue</b> 👉', 'utf8').toString('hex');
  assert.equal(decodeNotificationText(hex), 'Toko Blue 👉');
  assert.equal(decodeNotificationText('Plain title'), 'Plain title');
  assert.equal(decodeNotificationText(undefined), '');
});

test('formatNotification: title, time, order link and body', () => {
  const out = formatNotification(
    {
      title: Buffer.from('Confirm Receipt').toString('hex'),
      content: Buffer.from('Rate your items').toString('hex'),
      createtime: 1790679600,
      id_info: { orderid: 243739605230995 },
    },
    2,
  );
  assert.ok(out.startsWith('2. **Confirm Receipt** ('));
  assert.ok(out.includes('order `243739605230995`'));
  assert.ok(out.endsWith('Rate your items'));
});

// ─── account actions ─────────────────────────────────────────────────────────

test('shopVouchersFrom / formatShopVouchers: lists vouchers and marks claimed ones', () => {
  const tab = {
    data: {
      decoration: [
        { shop_voucher: null },
        {
          shop_voucher: {
            voucher_list: [
              {
                promotionid: 1,
                voucher_code: 'A',
                discount_value: 5390000000,
                min_spend: 53900000000,
              },
              {
                promotionid: 2,
                voucher_code: 'B',
                discount_value: 100000000,
                is_claimed_before: true,
              },
            ],
          },
        },
      ],
    },
  };
  const vouchers = shopVouchersFrom(tab);
  assert.equal(vouchers.length, 2);
  const out = formatShopVouchers('9', vouchers);
  assert.ok(out.includes('**Rp53.900 off** | code `A`'));
  assert.ok(out.includes('min. spend Rp539.000'));
  assert.ok(out.split('\n').find((l) => l.includes('code `B`')) !== undefined);
  assert.ok(out.includes('✅ claimed'));
  assert.ok(formatShopVouchers('9', []).includes('no claimable vouchers'));
});

test('findCartItem: by item, by item+model, and ambiguous multi-variant lines', () => {
  const blocks = [
    {
      items: [
        { itemid: 1, shopid: 9, modelid: 10, name: 'A', price: 1, quantity: 1 },
        { itemid: 1, shopid: 9, modelid: 11, name: 'A', price: 1, quantity: 2 },
        { itemid: 2, shopid: 9, modelid: 20, name: 'B', price: 1, quantity: 1 },
      ],
    },
  ];
  assert.equal(findCartItem(blocks, '2').item?.modelid, 20);
  assert.equal(findCartItem(blocks, '1', '11').item?.quantity, 2);
  const ambiguous = findCartItem(blocks, '1');
  assert.equal(ambiguous.item, undefined);
  assert.equal(ambiguous.matches.length, 2);
  assert.equal(findCartItem(blocks, '3').matches.length, 0);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('idleMsFrom: default, explicit, zero and invalid values', () => {
  assert.equal(idleMsFrom(undefined), DEFAULT_IDLE_MS);
  assert.equal(idleMsFrom(''), DEFAULT_IDLE_MS);
  assert.equal(idleMsFrom('60000'), 60000);
  assert.equal(idleMsFrom('0'), 0);
  assert.equal(idleMsFrom('-5'), DEFAULT_IDLE_MS);
  assert.equal(idleMsFrom('soon'), DEFAULT_IDLE_MS);
  assert.equal(idleMsFrom('1e12'), 2 ** 31 - 1);
});

test('idle closer: closes once the idle period passes after a call', async () => {
  let closes = 0;
  const idle = createIdleCloser(
    20,
    async () => void closes++,
    () => true,
  );
  await idle.track(async () => {});
  assert.equal(closes, 0);
  await sleep(60);
  assert.equal(closes, 1);
});

test('idle closer: never closes during a call, and a new call restarts the countdown', async () => {
  let closes = 0;
  const idle = createIdleCloser(
    30,
    async () => void closes++,
    () => true,
  );
  await idle.track(async () => {});
  await sleep(15);
  const slow = idle.track(() => sleep(60));
  assert.equal(idle.busy(), true);
  await sleep(45); // past the first countdown, still inside the slow call
  assert.equal(closes, 0);
  await slow;
  assert.equal(idle.busy(), false);
  await sleep(60);
  assert.equal(closes, 1);
});

test('idle closer: 0, disable() and a closed browser all prevent closing', async () => {
  let closes = 0;
  const close = async () => void closes++;
  await createIdleCloser(0, close, () => true).track(async () => {});
  await createIdleCloser(20, close, () => false).track(async () => {});
  const disabled = createIdleCloser(20, close, () => true);
  await disabled.track(async () => {});
  disabled.disable();
  await sleep(60);
  assert.equal(closes, 0);
});

await runTests();
console.log(
  `\n${failures === 0 ? '✅ All unit tests passed' : `❌ ${failures} unit test(s) failed`}\n`,
);
process.exit(failures === 0 ? 0 : 1);
