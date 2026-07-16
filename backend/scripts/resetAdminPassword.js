// Deterministically fixes the admin login regardless of root cause.
// Run from pos-web/:
//   node backend/scripts/resetAdminPassword.js
// or:
//   npm run reset-admin
//
// This does NOT try to recover any existing password (bcrypt hashes are
// one-way and can't be reversed). It either creates a fresh admin account
// or overwrites the password on the matching one, and clears any active
// login lockout, so this always results in a working admin/admin123 login
// no matter what state the account was in before.
//
// Replaces the old createAdmin.js and resetPasswords.js scripts, which
// only searched by `email` or only by `username` respectively (the User
// model didn't even have a `username` field until recently) and never
// cleared lockUntil/failedLoginAttempts.

require("dotenv").config({ path: require("path").join(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const User = require("../models/User");

const TARGET_USERNAME = "admin";
const TARGET_EMAIL = "admin@pos.local";
const NEW_PASSWORD = "admin123";

async function run() {
  const mongoURI = process.env.MONGO_URI;
  if (!mongoURI) {
    throw new Error("MONGO_URI is not set in pos-web/.env");
  }

  await mongoose.connect(mongoURI);
  console.log(`Connected to MongoDB Atlas. Database: "${mongoose.connection.name}"`);

  const hashedPassword = await bcrypt.hash(NEW_PASSWORD, 10);

  let user = await User.findOne({
    $or: [{ username: TARGET_USERNAME }, { email: TARGET_EMAIL }],
  });

  if (!user) {
    user = new User({
      name: "Administrator",
      username: TARGET_USERNAME,
      email: TARGET_EMAIL,
      password: hashedPassword,
      role: "admin",
    });
    await user.save();
    console.log(`Created new admin account. Collection: "${User.collection.collectionName}", _id: ${user._id}`);
  } else {
    user.username = TARGET_USERNAME;
    user.password = hashedPassword;
    user.failedLoginAttempts = 0;
    user.lockUntil = null;
    await user.save();
    console.log(`Found existing user (_id: ${user._id}) and reset its password + username + lockout state.`);
  }

  console.log("");
  console.log(`Username: ${TARGET_USERNAME}`);
  console.log(`Password: ${NEW_PASSWORD}`);
  console.log("");
  console.log("Login should now work. Change the password after logging in.");

  await mongoose.disconnect();
}

run().catch((error) => {
  console.error("Failed to reset admin password:", error.message);
  process.exitCode = 1;
});
