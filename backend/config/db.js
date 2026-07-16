const mongoose = require("mongoose");

// Single database, reached directly: Express -> Mongoose -> MongoDB Atlas.
// No local/cloud split and no HTTP sync layer anymore.
const mongoURI = process.env.MONGO_URI;

const hasValidMongoURI = mongoURI && mongoURI !== "undefined" && mongoURI !== "null" && mongoURI.length > 10;

const connectDB = async () => {
  if (!hasValidMongoURI) {
    console.error("❌ MONGO_URI is not set in pos-web/.env. Add your MongoDB Atlas connection string.");
    return mongoose;
  }

  // Without this, a query issued while disconnected (e.g. Atlas is
  // unreachable) silently "buffers" for up to 10s before finally erroring -
  // that's exactly what turned a DNS/network failure into a confusing
  // client-side "Login request timed out" 8+ seconds later instead of an
  // immediate, readable error. With buffering off, a query issued while
  // disconnected rejects instantly with a clear message.
  mongoose.set("bufferCommands", false);

  try {
    await mongoose.connect(mongoURI, {
      serverSelectionTimeoutMS: 10000, // Timeout after 10 seconds
      socketTimeoutMS: 45000,
    });
    console.log("✅ MongoDB Atlas Connected");
    return mongoose;
  } catch (error) {
    console.error(`❌ MongoDB Connection Error: ${error.message}`);
    console.error("⚠️ Check your internet connection, MongoDB Atlas cluster status, and Atlas Network Access (IP Access List).");
    // Don't throw error - allow app to start; routes will fail fast (not
    // hang) until the DB is reachable, and will auto-recover once it is -
    // Mongoose keeps retrying the connection in the background.
    return mongoose;
  }
};

module.exports = { connectDB };
