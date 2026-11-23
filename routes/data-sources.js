const router = require("express").Router();
const { Lead } = require("../models");
const { wrap } = require("../utils/http");
const { scopeFilter } = require("../utils/access");

// GET /api/data-sources
// Returns lead counts grouped by source and imported dataset.
router.get(
  "/data-sources",
  wrap(async (req, res) => {
    const filter = scopeFilter(req.user);

    const [bySource, byDataset] = await Promise.all([
      Lead.aggregate([
        { $match: filter },
        {
          $group: {
            _id: "$source",
            total: { $sum: 1 },
            qualified: {
              $sum: {
                $cond: [{ $eq: ["$status", "qualified"] }, 1, 0],
              },
            },
            converted: {
              $sum: {
                $cond: [{ $eq: ["$status", "sale_done"] }, 1, 0],
              },
            },
            unassigned: {
              $sum: {
                $cond: [{ $eq: ["$assigned_to", null] }, 1, 0],
              },
            },
          },
        },
        { $sort: { total: -1 } },
      ]),

      Lead.aggregate([
        {
          $match: {
            ...filter,
            source_dataset: { $nin: [null, ""] },
          },
        },
        {
          $group: {
            _id: {
              source: "$source",
              dataset: "$source_dataset",
            },
            total: { $sum: 1 },
            qualified: {
              $sum: {
                $cond: [{ $eq: ["$status", "qualified"] }, 1, 0],
              },
            },
            converted: {
              $sum: {
                $cond: [{ $eq: ["$status", "sale_done"] }, 1, 0],
              },
            },
            unassigned: {
              $sum: {
                $cond: [{ $eq: ["$assigned_to", null] }, 1, 0],
              },
            },
            last_imported_at: { $max: "$created_at" },
          },
        },
        { $sort: { last_imported_at: -1 } },
      ]),
    ]);

    const sources = bySource.map((row) => ({
      source: row._id || "other",
      total: row.total,
      qualified: row.qualified,
      converted: row.converted,
      unassigned: row.unassigned,
    }));

    const datasets = byDataset.map((row) => ({
      source: row._id.source || "other",
      dataset_name: row._id.dataset,
      total: row.total,
      qualified: row.qualified,
      converted: row.converted,
      unassigned: row.unassigned,
      last_imported_at: row.last_imported_at,
    }));

    res.json({
      sources,
      datasets,
      total_leads: sources.reduce((sum, row) => sum + row.total, 0),
    });
  }),
);

module.exports = router;
