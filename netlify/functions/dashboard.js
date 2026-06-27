const AD_ACCOUNT_ID = Netlify.env.get('META_AD_ACCOUNT_ID') || '313827266010023';
const ACCESS_TOKEN  = Netlify.env.get('META_ACCESS_TOKEN') || '';
const GRAPH_BASE    = 'https://graph.facebook.com/v21.0';

async function graphFetch(path, params = {}) {
  const url = new URL(`${GRAPH_BASE}${path}`);
  url.searchParams.set('access_token', ACCESS_TOKEN);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : v);
  }
  const res = await fetch(url.toString());
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json;
}

function getPurchases(actions) {
  if (!actions) return 0;
  const a = actions.find(x => x.action_type === 'omni_purchase' || x.action_type === 'purchase');
  return a ? parseFloat(a.value) : 0;
}
function getCostPerPurchase(costPerAction) {
  if (!costPerAction) return null;
  const a = costPerAction.find(x => x.action_type === 'omni_purchase' || x.action_type === 'purchase');
  return a ? parseFloat(a.value) : null;
}
function getRoas(purchase_roas) {
  if (!purchase_roas) return null;
  if (Array.isArray(purchase_roas)) {
    const a = purchase_roas.find(x => x.action_type === 'omni_purchase' || x.action_type === 'purchase');
    return a ? parseFloat(a.value) : null;
  }
  return parseFloat(purchase_roas) || null;
}

export default async (req) => {
  if (!ACCESS_TOKEN) {
    return Response.json({ error: 'NO_TOKEN', message: 'META_ACCESS_TOKEN is not set in Netlify environment variables.' }, { status: 401 });
  }

  const url = new URL(req.url);
  const datePreset = url.searchParams.get('date_preset') || 'last_30d';

  try {
    const insightFields = 'spend,impressions,clicks,ctr,cpc,cpm,reach,frequency,purchase_roas,actions,action_values,cost_per_action_type';

    const [accountRes, campaignInsightsRes, campaignListRes, adsetRes] = await Promise.all([
      graphFetch(`/act_${AD_ACCOUNT_ID}/insights`, { fields: insightFields, date_preset: datePreset, level: 'account' }),
      graphFetch(`/act_${AD_ACCOUNT_ID}/insights`, { fields: `campaign_id,campaign_name,${insightFields}`, date_preset: datePreset, level: 'campaign', limit: 50 }),
      graphFetch(`/act_${AD_ACCOUNT_ID}/campaigns`, { fields: 'id,name,status,effective_status,objective,daily_budget,lifetime_budget', limit: 50 }),
      graphFetch(`/act_${AD_ACCOUNT_ID}/insights`, { fields: `adset_id,adset_name,campaign_name,${insightFields}`, date_preset: datePreset, level: 'adset', sort: 'spend_descending', limit: 20 }),
    ]);

    const accountRow = (accountRes.data || [])[0] || {};
    const account = {
      spend:            parseFloat(accountRow.spend || 0),
      impressions:      parseInt(accountRow.impressions || 0),
      clicks:           parseInt(accountRow.clicks || 0),
      ctr:              parseFloat(accountRow.ctr || 0),
      cpc:              parseFloat(accountRow.cpc || 0),
      cpm:              parseFloat(accountRow.cpm || 0),
      reach:            parseInt(accountRow.reach || 0),
      frequency:        parseFloat(accountRow.frequency || 0),
      purchases:        getPurchases(accountRow.actions),
      roas:             getRoas(accountRow.purchase_roas),
      cost_per_purchase: getCostPerPurchase(accountRow.cost_per_action_type),
    };

    const insightsMap = {};
    for (const row of (campaignInsightsRes.data || [])) insightsMap[row.campaign_id] = row;

    const campaigns = (campaignListRes.data || []).map(c => {
      const ins = insightsMap[c.id] || {};
      return {
        id:               c.id,
        name:             c.name,
        status:           c.effective_status || c.status,
        objective:        c.objective,
        daily_budget:     c.daily_budget ? parseFloat(c.daily_budget) / 100 : null,
        spend:            parseFloat(ins.spend || 0),
        impressions:      parseInt(ins.impressions || 0),
        clicks:           parseInt(ins.clicks || 0),
        ctr:              parseFloat(ins.ctr || 0),
        cpc:              parseFloat(ins.cpc || 0),
        reach:            parseInt(ins.reach || 0),
        frequency:        parseFloat(ins.frequency || 0),
        roas:             getRoas(ins.purchase_roas),
        purchases:        getPurchases(ins.actions),
        cost_per_purchase: getCostPerPurchase(ins.cost_per_action_type),
      };
    }).sort((a, b) => b.spend - a.spend);

    const adsets = (adsetRes.data || []).map(a => ({
      id:               a.adset_id,
      name:             a.adset_name,
      campaign:         a.campaign_name,
      spend:            parseFloat(a.spend || 0),
      impressions:      parseInt(a.impressions || 0),
      clicks:           parseInt(a.clicks || 0),
      ctr:              parseFloat(a.ctr || 0),
      cpc:              parseFloat(a.cpc || 0),
      reach:            parseInt(a.reach || 0),
      frequency:        parseFloat(a.frequency || 0),
      roas:             getRoas(a.purchase_roas),
      purchases:        getPurchases(a.actions),
      cost_per_purchase: getCostPerPurchase(a.cost_per_action_type),
    }));

    return Response.json({ ok: true, fetched_at: new Date().toISOString(), date_preset: datePreset, account, campaigns, adsets });

  } catch (err) {
    return Response.json({ error: 'FETCH_ERROR', message: err.message }, { status: 500 });
  }
};

export const config = { path: '/api/dashboard' };
