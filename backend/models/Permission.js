const mongoose = require("mongoose");

// Read-only catalog collection, seeded once from config/permissions.js.
// Role.permissions stores the permission *keys* directly (a denormalized
// string array) rather than ObjectId references - that avoids a join on
// every single permission check (requirePermission runs on nearly every
// authenticated request). This collection exists so the Super Admin /
// Shop Owner frontends have a database-backed source of truth to render
// the permission picker from, and so new permissions can be added without
// a code deploy touching every Role document.
const permissionSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, trim: true },
    label: { type: String, required: true },
    module: { type: String, required: true },
    description: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Permission", permissionSchema);
