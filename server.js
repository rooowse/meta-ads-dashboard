require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5173;
const AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID || '313827266010023';
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
const GRAPH_BASE = 'https://graph.facebook.com/v21.0';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

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

// ── Account-level overview ──────────────────────────────────────
async function getAccountInsights(datePreset) {
  const fields = [
    'spend', 'impressions', 'clicks', 'ctr', 'cpc', 'cpm',
    'reach', 'frequency', 'purchase_roas',
    'actions', 'action_values', 'cost_per_action_type'
  ].join(',');
  return graphFetch(`/act_${AD_ACCOUNT_ID}/insights`, {
    fields,
    date_preset: datePreset,
    level: 'account'
  });
}

// ── Campaigns ───────────────────────────────────────────────────
async function getCampaigns(datePreset) {
  // Fetch campaign list with status
  const listRes = await graphFetch(`/act_${AD_ACCOUNT_ID}/campaigns`, {
    fields: 'id,name,status,effective_status,objective,daily_budget,lifetime_budget',
    limit: 50
  });
  const campaigns = listRes.data || [];

  // Fetch insights for ALL campaigns in one batch call
  const insightsRes = await graphFetch(`/act_${AD_ACCOUNT_ID}/insights`, {
    fields: 'campaign_id,campaign_name,spend,impressions,clicks,ctr,cpc,cpm,reach,frequency,purchase_roas,actions,cost_per_action_type',
    date_preset: datePreset,
    level: 'campaign',
    limit: 50
  });
  const insightsMap = {};
  for (const row of (insightsRes.data || [])) {
    insightsMap[row.campaign_id] = row;
  }

  return campaigns.map(c => ({
    ...c,
    insights: insightsMap[c.id] || null
  }));
}

// ── Ad Sets ──────────────────────────────────────────────────────
async function getAdSets(datePreset) {
  const res = await graphFetch(`/act_${AD_ACCOUNT_ID}/insights`, {
    fields: 'adset_id,adset_name,campaign_name,spend,impressions,clicks,ctr,cpc,cpm,reach,frequency,purchase_roas,actions,cost_per_action_type',
    date_preset: datePreset,
    level: 'adset',
    sort: 'spend_descending',
    limit: 20
  });
  // Also get delivery status
  const statusRes = await graphFetch(`/act_${AD_ACCOUNT_ID}/adsets`, {
    fields: 'id,name,effective_status,daily_budget,delivery_info',
    filtering: JSON.stringify([{ field: 'adset.effective_status', operator: 'IN', value: ['ACTIVE', 'LEARNING', 'LEARNING_LIMITED'] }]),
    limit: 20
  });
  const statusMap = {};
  for (const a of (statusRes.data || [])) statusMap[a.id] = a;

  return (res.data || []).map(row => ({
    ...row,
    status_info: statusMap[row.adset_id] || null
  }));
}

// ── API endpoint ────────────────────────────────────────────────
app.get('/api/dashboard', async (req, res) => {
  if (!ACCESS_TOKEN) {
    return res.status(401).json({
      error: 'NO_TOKEN',
      message: 'META_ACCESS_TOKEN is not set. Add it to your .env file and restart the server.'
    });
  }

  const datePreset = req.query.date_preset || 'last_30d';

  try {
    const [accountData, campaigns, adsets] = await Promise.all([
      getAccountInsights(datePreset),
      getCampaigns(datePreset),
      getAdSets(datePreset)
    ]);

    // Extract purchases from actions
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

    const accountRow = (accountData.data || [])[0] || {};
    const account = {
      spend: parseFloat(accountRow.spend || 0),
      impressions: parseInt(accountRow.impressions || 0),
      clicks: parseInt(accountRow.clicks || 0),
      ctr: parseFloat(accountRow.ctr || 0),
      cpc: parseFloat(accountRow.cpc || 0),
      cpm: parseFloat(accountRow.cpm || 0),
      reach: parseInt(accountRow.reach || 0),
      frequency: parseFloat(accountRow.frequency || 0),
      purchases: getPurchases(accountRow.actions),
      roas: getRoas(accountRow.purchase_roas),
      cost_per_purchase: getCostPerPurchase(accountRow.cost_per_action_type)
    };

    const campaignList = campaigns.map(c => {
      const ins = c.insights || {};
      return {
        id: c.id,
        name: c.name,
        status: c.effective_status || c.status,
        objective: c.objective,
        daily_budget: c.daily_budget ? parseFloat(c.daily_budget) / 100 : null,
        spend: parseFloat(ins.spend || 0),
        impressions: parseInt(ins.impressions || 0),
        clicks: parseInt(ins.clicks || 0),
        ctr: parseFloat(ins.ctr || 0),
        cpc: parseFloat(ins.cpc || 0),
        reach: parseInt(ins.reach || 0),
        frequency: parseFloat(ins.frequency || 0),
        roas: getRoas(ins.purchase_roas),
        purchases: getPurchases(ins.actions),
        cost_per_purchase: getCostPerPurchase(ins.cost_per_action_type)
      };
    }).sort((a, b) => b.spend - a.spend);

    const adsetList = adsets.map(a => ({
      id: a.adset_id,
      name: a.adset_name,
      campaign: a.campaign_name,
      status: a.status_info?.effective_status || 'ACTIVE',
      daily_budget: a.status_info?.daily_budget ? parseFloat(a.status_info.daily_budget) / 100 : null,
      spend: parseFloat(a.spend || 0),
      impressions: parseInt(a.impressions || 0),
      clicks: parseInt(a.clicks || 0),
      ctr: parseFloat(a.ctr || 0),
      cpc: parseFloat(a.cpc || 0),
      reach: parseInt(a.reach || 0),
      frequency: parseFloat(a.frequency || 0),
      roas: getRoas(a.purchase_roas),
      purchases: getPurchases(a.actions),
      cost_per_purchase: getCostPerPurchase(a.cost_per_action_type)
    }));

    res.json({
      ok: true,
      fetched_at: new Date().toISOString(),
      date_preset: datePreset,
      account,
      campaigns: campaignList,
      adsets: adsetList
    });

  } catch (err) {
    res.status(500).json({ error: 'FETCH_ERROR', message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n  Hoka Lash Dashboard running at http://localhost:${PORT}\n`);
});
