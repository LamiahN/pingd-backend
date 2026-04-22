const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args)); // to use fetch in Node.js environment (for calling Flask API from backend)
const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

app.use('/static', express.static('static'));

let queue = []; // for testing purposes, to be replaced by MongoDB collections in implementation
// in-memory queue for testing purposes (not used in actual implementation with MongoDB)  
app.post('/join-queue', (req, res) => {
    const name = req.body.name;
    queue.push(name);
    res.json({ position: queue.length });
});

// function to calculate distance between two lat/lon points using Haversine formula 
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth radius in km

    // convert degrees to radians
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;

    // haversine formula
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) *
        Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);

    // angular distance in radians
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c; 
}

async function calculateEWT(entry, db) { // when user checks their status in queue

    const { ObjectId } = require('mongodb');

    // effective position
    const effectivePosition = await db.collection('QueueEntry').countDocuments({
        queueId: entry.queueId,
        position: { $lt: entry.position },
        status: { $in: ["waiting", "delayed"] }
    }) + 1;

    // get queue
    const queue = await db.collection('Queue').findOne({
        _id: new ObjectId(entry.queueId)
    });

    let queueType = queue?.queueType || "dine-in";

    // avg service time
    let avgServiceTime;

    if (queueType === "dine-in") {
        if (entry.partySize <= 2) avgServiceTime = 20;
        else if (entry.partySize <= 4) avgServiceTime = 30;
        else avgServiceTime = 45;
    } else {
        avgServiceTime = 7;
    }

    // ML call
    let updatedWaitTime = 0;

    try {
        const response = await fetch("http://127.0.0.1:5000/predict", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                position: effectivePosition,
                avgServiceTime: avgServiceTime,
                partySize: entry.partySize || 1,
                queueType: queueType
            })
        });

        const data = await response.json();
        updatedWaitTime = data.estimatedWaitTime;

    } catch (error) {
        console.error("ML error:", error);
    }

    if (entry.status === "ready") {
        updatedWaitTime = 0;
    }

    return {
        effectivePosition,
        updatedWaitTime
    };
}

// MONGODB CONNECTION ------------------------------
const MongoClient = require('mongodb').MongoClient; 

// mongodb connection link to UGproject database
const uri = "mongodb+srv://ln439_db_user:y4X1ZHAsVV9DLKXD@ugprojectcluster.szhht3p.mongodb.net/?appName=UGprojectCluster" // had to create a new cluster due to mongoDB side connection issue - updated on April 1 2026

let db;
MongoClient.connect( 
    uri, 
    { useUnifiedTopology: true },  // to manage connections more efficiently 
    (err, client) => { // connected MongoDB client
        if (err) {
            console.error('MongoDB connection error:', err);
            return;
        }
        db = client.db('UGproject'); 
        console.log('Connected to Database: UGproject');
    }
); 

// accessing restaurant data for dine-in ------------------
app.get('/restaurants/dinein', async (req, res) => {
    try {
      const restaurants = await db.collection('restaurants_dinein').find().toArray();
      res.json(restaurants);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
});

// GET TAKEAWAY RESTAURANTS WITH QUEUE INFO -----------------
app.get('/takeawayWithQueue', async (req, res) => {

    try {
        const restaurants = await db.collection('restaurants_takeaway').find().toArray();
        const queues = await db.collection('Queue').find({ queueType: "takeaway" }).toArray();

        const result = restaurants.map(r => {

            const rIdBase64 = r.restaurant_id?.buffer?.toString('base64');

            const queue = queues.find(q => {
                return q.restaurantID === rIdBase64;
            });

            return {
                ...r, // ... include all original restaurant fields
                restaurant_id: rIdBase64, // convert Binary to base64 string for frontend use (restaurant_id is stored as Binary in MongoDB)
                queueLength: queue?.queueLength || 0,
                estimatedWaitTime: queue?.estimatedWaitTime || 0
            };
        });

        res.json(result);

    } catch (err) {
        console.error(err);
        res.status(500).send("Error fetching takeaway restaurants");
    }
});

// accessing trending menu items for specific restaurant (dine-in) ------------------
app.get('/menu/:restaurantId/trending', async (req, res) => {
    const restaurantId = parseInt(req.params.restaurantId);

    try {
        const trending = await db.collection('menu_items')
            .find({ restaurant_id: restaurantId })
            .sort({ favourite_count: -1 })
            .limit(3)
            .toArray();

        res.json(trending);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// accessing menu items for specific restaurant (for dine-in) ------------------
app.get('/menu/:restaurantId', async (req, res) => {
    const restaurantId = parseInt(req.params.restaurantId);

    try {
        const items = await db.collection('menu_items').find({
            restaurant_id: restaurantId
        }).toArray();

        res.json(items);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// accessing restaurant data for take-away ------------------
app.get('/restaurants/takeaway', async (req, res) => {
    try {
      const restaurants = await db.collection('restaurants_takeaway').find().toArray();
      res.json(restaurants);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
});

// recommendation system for similar restaurants based on categories, ratings and distance (for dine-in) ------------------
app.get('/recommendations/restaurants/:restaurantId', async (req, res) => {
    const restaurantId = parseInt(req.params.restaurantId);

    try {
        // current restaurant
        const current = await db.collection('restaurants_dinein').findOne({
            restaurant_id: restaurantId
        });

        if (!current) {
            return res.status(404).json({ message: "Restaurant not found" });
        }

        // similar restaurants
        let recommendations = await db.collection('restaurants_dinein')
            .find({
                categories: current.categories,
                restaurant_id: { $ne: restaurantId }
            })
        .toArray();

        // calculate score for each recommendation based on rating and distance
        recommendations = recommendations.map(r => {
            const distance = getDistance(
                current.latitude,
                current.longitude,
                r.latitude,
                r.longitude
            );
        
            // normalise rating out of 5
            const ratingScore = r.rating / 5;
        
            // normalise distance (closer is better)
            const maxDistance = 10; // assume 10km max relevant
            const proximityScore = 1 - Math.min(distance / maxDistance, 1);
        
            // weighted score
            const score = (0.7 * ratingScore) + (0.3 * proximityScore);
        
            return {
                ...r,
                distance,
                score
            };
        });
        
        // sort by score
        recommendations.sort((a, b) => b.score - a.score);

        // return top 3
        res.json(recommendations.slice(0, 3));

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// accessing menu items (for dine-in restaurants) ------------------
app.get('/menu', async (req, res) => {
    try {
      const menu = await db.collection('menu_items').find().toArray();
      res.json(menu);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
});

// SIGN UP ROUTE ------------------------------
const bcrypt = require('bcryptjs');
app.post('/signup', async (req, res) => {
    const user = req.body;

    // check if user with same email already exists
    const existingUser = await db.collection('users').findOne({ 
        email: user.email.toLowerCase()
    });

    if (existingUser) {
        return res.json({ message: 'User already exists' });
    }

    // hash password
    const hashedPassword = await bcrypt.hash(user.password, 10);

    await db.collection('users').insertOne({
        fullName: user.fullName,
        email: user.email.toLowerCase(),
        password: hashedPassword, 
        dob: user.dob
    });

    res.json({ message: 'Signup successful' });
});

// LOGIN ROUTE ------------------------------
app.post('/login', async (req, res) => {
    const { email, password } = req.body;

    // check if email and password are provided
    if (!email || !password) {
        return res.json({ message: 'All fields are required' });
    }

    // find user by email
    const user = await db.collection('users').findOne({
        email: email.toLowerCase()
    });

    // if user not found, return error message
    if (!user) {
        return res.json({ message: 'User not found' });
    }

    // compare entered password with hashed password in db
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
        return res.json({ message: 'Incorrect password' });
    }
    res.json({ message: 'Login successful', user }); // change to pop up message
});

// ADMIN LOGIN ROUTE (to be enhanced with role-based access control in the future) ------------------------------
app.post('/adminLogin', async (req, res) => {

    const { email, password } = req.body;

    try {
        const admin = await db.collection('users').findOne({
            email,
            roleType: "admin"
        });

        if (!admin || admin.password !== password) {
            return res.json({ message: "Invalid credentials" });
        }

        res.json({
            message: "Login successful",
            admin: {
                email: admin.email,
                restaurantID: admin.restaurantID
            }
        });

    } catch (err) {
        console.error(err);
        res.status(500).send("Error logging in");
    }
});

// GET DINE-IN QUEUES FOR ADMIN ------------------------------
app.get('/adminQueues/:restaurantID', async (req, res) => {
    const restaurantID = req.params.restaurantID;

    try {
        console.log("Fetching queues for:", restaurantID);

        const queues = await db.collection('Queue').find({
            restaurantID: parseInt(restaurantID)
        }).toArray();

        res.json(queues);

    } catch (err) {
        console.error(err);
        res.status(500).send("Error fetching admin queues");
    }
});

// GET TAKEAWAY QUEUES FOR ADMIN ------------------------------
app.get('/adminQueuesTakeaway/:restaurantID', async (req, res) => {

    const restaurantID = req.params.restaurantID; // string / base64

    try {

        const queues = await db.collection('Queue').find({
            restaurantID: restaurantID,
            queueType: "takeaway"
        }).toArray();

        res.json(queues);

    } catch (err) {
        console.error(err);
        res.status(500).send("Error fetching takeaway queues");
    }
});

// GET OR CREATE QUEUE FOR RESTAURANT ------------------------------
app.post('/getOrCreateQueue', async (req, res) => {
    const restaurantID = req.body.restaurantID; // removed parseInt here to allow for string IDs as well (to use UUIDs for takeaway restaurants)
    const { queueType } = req.body;

    try {
        // check if queue already exists
        let queue = await db.collection('Queue').findOne({
            restaurantID,
            queueType
        });

        // if not, create one
        if (!queue) {
            const newQueue = {
                restaurantID,
                queueType,
                createdAt: new Date(),
                operatingStatus: true,
                queueCode: Math.floor(1000 + Math.random() * 9000) // random 4-digit code for restaurant queue
            };

            const result = await db.collection('Queue').insertOne(newQueue);
            queue = result.ops[0]; // new created queue
        }

        res.json(queue);

    } catch (err) {
        console.error(err);
        res.status(500).send("Error creating or fetching queue");
    }
});


// CREATE QUEUE ROUTE ------------------------------
app.post('/createQueue', async (req, res) => {
    const { restaurantID, queueType } = req.body; // expecting restaurantID and queueType from req body
  
    // new queue object 
    const newQueue = {
      restaurantID,
      estimatedWaitTime: 0,
      createdAt: new Date(),
      operatingStatus: true,
      queueType
    };
  
    // insert new queue object into "Queue" collection
    const result = await db.collection('Queue').insertOne(newQueue);
    res.json(result.ops[0]); // return the newly created queue object for frontend using
});

// ADD USER TO QUEUE ROUTE ------------------------------
app.post('/addToQueue', async (req, res) => {
    const { queueId, email, partySize, queueCode } = req.body; 

    const { ObjectId } = require('mongodb');
    const queueObjectId = new ObjectId(queueId);    

    console.log("EMAIL RECEIVED:", req.body.email);
  
    // ensure required fields are given
    if (!queueId || !email) {
      return res.status(400).json({ message: "Missing required fields" });
    }
  
    // check if user exists
    const user = await db.collection('users').findOne({
        email: email.toLowerCase()
    });

    // debugging 
    console.log("Searching for user with email:", email);
  
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // check if user already in queue
    const existingEntry = await db.collection('QueueEntry').findOne({
        queueId: queueObjectId,
        userId: user._id,
        status: { $in: ["waiting", "delayed", "ready"] }
    });

    if (existingEntry) {
        return res.json({ message: "User already in queue" });
    }
  
    // count current queue size
    const count = await db.collection('QueueEntry').countDocuments({ queueId: queueObjectId });

    // get queue details (to know if dine-in or takeaway)
    const queue = await db.collection('Queue').findOne({ _id: new require('mongodb').ObjectId(queueId) });

    // validate queue code to prevent unauthorized access (restaurant to share code with customers to ensure they join the correct queue)
    if (queue.queueCode !== parseInt(queueCode)) {
        return res.json({ message: "Invalid queue code" });
    }

    // ensure queue exists
    if (!queue) {
        return res.status(404).json({ message: "Queue not found" });
    }

    const queueType = queue.queueType; 

    // estimate avg service time (same logic used in ML dataset)
    let avgServiceTime;

    if (queueType === "dine-in") {
        if (partySize <= 2) avgServiceTime = 20;
        else if (partySize <= 4) avgServiceTime = 30;
        else avgServiceTime = 45;
    } else {
        avgServiceTime = 7; // takeaway average constant 
    }

    let estimatedWaitTime; // to be calculated by ML model 

    try {
        const response = await fetch("http://127.0.0.1:5000/predict", { // ML API call to predict wait time 
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                position: count + 1,
                avgServiceTime: avgServiceTime,
                partySize: partySize || 1,
                queueType: queueType
            })
        });
        console.log("Flask response status:", response.status);
    
        const data = await response.json();
        console.log("Flask response data:", data);
    
        estimatedWaitTime = data.estimatedWaitTime; // predicted wait time from ML model
    
    } catch (error) {
        console.error("Flask API error:", error);
        estimatedWaitTime = 0;
    }

    // create queue entry
    const newEntry = {
        queueId: new ObjectId(queueId), // fix to convert string ID to ObjectId type for MongoDB
        userId: user._id,
        partySize: partySize || null,
        // orderNo: orderNo || null, // field for future use (take-out orders)
        joinedAt: new Date(),
        position: count + 1,
        status: "waiting",
        estimatedWaitTime: estimatedWaitTime, 
        updatedAt: new Date()
    };
  
    const result = await db.collection('QueueEntry').insertOne(newEntry);

    // recalculate queue summary
    const updatedCount = await db.collection('QueueEntry').countDocuments({
        queueId: queueObjectId
    });

    // simple total wait time (sum of all entries or approximate)
    const totalWaitTime = updatedCount * avgServiceTime;

    // update Queue collection
    await db.collection('Queue').updateOne(
        { _id: queueObjectId },
        { 
            $set: { 
                estimatedWaitTime: totalWaitTime,
                queueLength: updatedCount
            } 
        }
    );
  
    // debug logs to verify updated queue summary
    console.log("Updated Queue Summary:", {
        queueLength: updatedCount,
        estimatedWaitTime: totalWaitTime
    });

    // respond: success message and new entry ID
    res.json({
      message: "User added to queue",
      entryId: result.insertedId
    });
});

// GET QUEUE SUMMARY FOR RESTAURANT ------------------------------
app.get('/queueSummary/:restaurantID', async (req, res) => {

    const restaurantID = parseInt(req.params.restaurantID);

    try {
        // find queue for this restaurant
        const queue = await db.collection('Queue').findOne({
            restaurantID,
            queueType: "dine-in"
        });

        if (!queue) {
            return res.json({
                queueSize: 0,
                estimatedWaitTime: 0
            });
        }

        const { ObjectId } = require('mongodb');

        // count users in queue
        const entries = await db.collection('QueueEntry').find({
            queueId: queue._id,
            status: { $in: ["waiting", "delayed"] }
        }).toArray();

        const queueSize = entries.length;

        // simple wait time calculation
        let totalWaitTime = 0;

        entries.forEach(entry => {
            totalWaitTime += entry.estimatedWaitTime || 0;
        });

        res.json({
            queueSize,
            estimatedWaitTime: totalWaitTime
        });

    } catch (err) {
        console.error(err);
        res.status(500).send("Error fetching queue summary");
    }
});

// GET QUEUE STATUS ROUTE ------------------------------
// for displaying queue status on admin dashboard 
app.get('/queue/:queueId', async (req, res) => {
    const { queueId } = req.params;
  
    // get queue entries sort by position
    const entries = await db.collection('QueueEntry')
      .find({ queueId })
      .sort({ position: 1 })
      .toArray();
  
    // get users
    const users = await db.collection('users').find().toArray();
  
    const enriched = entries.map(entry => { // enrich queue entry with user info from users collection
      const user = users.find(u => u._id.toString() === entry.userId.toString());
  
      return {
        _id: entry._id,
        position: entry.position,
        partySize: entry.partySize,
        status: entry.status,
        name: user?.fullName || "Unknown",
        email: user?.email || "unknown"
      };
    });
  
    res.json(enriched); // return to frontend for display

});

// updated to specify which queue entry to update in case a user is in multiple queues 
app.put('/notifyCustomer', async (req, res) => {

    const { ObjectId } = require('mongodb');
    const { userId, queueId } = req.body;

    try {
        await db.collection('QueueEntry').updateOne(
            {
                userId: new ObjectId(userId),
                queueId: new ObjectId(queueId)
            },
            {
                $set: {
                    status: "ready",
                    updatedAt: new Date()
                }
            }
        );

        res.json({ message: "Customer notified" });

    } catch (err) {
        console.error(err);
        res.status(500).send("Error notifying customer");
    }
});

// REMOVE CUSTOMER FROM QUEUE ROUTE ------------------------------
app.delete('/removeCustomer/:id', async (req, res) => {
    const { id } = req.params; // id of queue entry to remove
  
    const ObjectId = require('mongodb').ObjectId;
  
    // find the entry 
    const entry = await db.collection('QueueEntry').findOne({ 
      _id: new ObjectId(id)
    });
  
    if (!entry) {
      return res.status(404).json({ message: "Entry not found" });
    }
  
    // get queueId before deleting the entry
    const queueId = entry.queueId;
  
    // delete the entry
    await db.collection('QueueEntry').deleteOne({
      _id: new ObjectId(id)
    });
  
    // get remaining entries in that queue
    const remaining = await db.collection('QueueEntry')
      .find({ queueId })
      .sort({ joinedAt: 1 }) // oldest first
      .toArray();
  
    // reassign positions to the rest of the entries
    for (let i = 0; i < remaining.length; i++) {
      await db.collection('QueueEntry').updateOne(
        { _id: remaining[i]._id },
        {
          $set: { 
            position: i + 1,
            updatedAt: new Date()
          }
        }
      );
    }
  
    res.json({ message: "Customer removed and positions updated" });
});

// GET USER'S QUEUE POSITION AND STATUS ROUTE ------------------------------
// for customer to check their status in the queue after joining
app.get('/getQueueEntry/:userId', async (req, res) => {

    const { ObjectId } = require('mongodb'); // convert string ID to mongoDB ObjectId type

    const userId = req.params.userId; 

    try { 
        const entry = await db.collection('QueueEntry')
            .find({
                userId: new ObjectId(userId),
                status: { $in: ["waiting", "delayed", "ready"] }
            })
            .sort({ updatedAt: -1 }) // most recent version
            .limit(1)
            .toArray()
            .then(results => results[0]);
        // console.log("User joinedAt:", entry.joinedAt); // debugging log to check joinedAt value for the user's queue entry

        if (!entry) {
            console.log("No queue entry found for user:", userId);
            return res.json(null);
        } 

        // determine queue type
        const queue = await db.collection('Queue').findOne({
            _id: new ObjectId(entry.queueId)
        });
        let queueType = queue?.queueType || "dine-in";

        // estimate avg service time
        let avgServiceTime;

        if (queueType === "dine-in") {
            if (entry.partySize <= 2) avgServiceTime = 20;
            else if (entry.partySize <= 4) avgServiceTime = 30;
            else avgServiceTime = 45;
        } else {
            avgServiceTime = 7;
        }

        // calculate EWT using ML model 
        let updatedWaitTime; 
        let effectivePosition;

        try { // in case ML API call fails, fallback to a simple EWT calculation based on position and avg service time 
            const result = await calculateEWT(entry, db);
            effectivePosition = result.effectivePosition; 
            updatedWaitTime = result.updatedWaitTime;

        } catch (error) {
            console.error("EWT error:", error);
            
            // fallback (default)
            effectivePosition = entry.position;
            updatedWaitTime = 0;
        }

        // adjusted based on status
        if (entry.status === "ready") {
            updatedWaitTime = 0;
        }

        // response to FE
        res.json({
            position: effectivePosition,
            status: entry.status,
            partySize: entry.partySize,
            estimatedWaitTime: updatedWaitTime
        });

        // debug logs
        console.log({
            position: effectivePosition, 
            partySize: entry.partySize,
            avgServiceTime,
            queueType
        });

        //console.log("Predicted wait time:", updatedWaitTime);

    } catch (err) {
        console.error(err);
        res.status(500).send("Server error");
    }
});

// GET ALL USER QUEUE SESSIONS ------------------------------
// for customer to see all their active queue sessions 
app.get('/userQueues/:userId', async (req, res) => {

    const { ObjectId } = require('mongodb');
    const userId = new ObjectId(req.params.userId);

    try {
        const entries = await db.collection('QueueEntry')
            .find({
                userId,
                status: { $in: ["waiting", "delayed", "ready"] }
            })
            .toArray();

        // get all queues
        const queues = await db.collection('Queue').find().toArray();

        const dinein = await db.collection('restaurants_dinein').find().toArray();
        const takeaway = await db.collection('restaurants_takeaway').find().toArray();

        const result = await Promise.all(entries.map(async (entry) => {

            const queue = queues.find(q => q._id.toString() === entry.queueId.toString());
        
            let restaurant;

            // Try dine-in 
            restaurant = dinein.find(
                r => String(r.restaurant_id) === String(queue?.restaurantID)
            );

            if (!restaurant) {
                restaurant = takeaway.find(r => {
            
                    let rId;
            
                    // convert Binary to Base64 string
                    if (r.restaurant_id && r.restaurant_id._bsontype === 'Binary') {
                        rId = r.restaurant_id.buffer.toString('base64');
                    } else {
                        rId = String(r.restaurant_id);
                    }
            
                    const qId = String(queue?.restaurantID);
            
                    return rId === qId;
                });
            }
        

            const { effectivePosition, updatedWaitTime } = await calculateEWT(entry, db);
        
            return {
                queueId: entry.queueId.toString(),
                restaurantName: restaurant?.brand_name || "Unknown",
                position: effectivePosition,
                status: entry.status,
                estimatedWaitTime: updatedWaitTime,
                partySize: entry.partySize,
                restaurantID: queue?.restaurantID,
                queueType: queue?.queueType,
                updatedAt: entry.updatedAt
            };
        }));

        res.json(result);

    } catch (err) {
        console.error(err);
        res.status(500).send("Error fetching user queues");
    }
});

// LEAVE SPECIFIC QUEUE ------------------------------
// updated for the case where a user might be in multiple queues 
app.delete('/leaveQueue', async (req, res) => {

    const { ObjectId } = require('mongodb');
    const { userId, queueId } = req.body;

    try {

         // to handle both ObjectId and string
         let formattedQueueId;

        if (ObjectId.isValid(queueId)) {
            formattedQueueId = new ObjectId(queueId);
        } else {
            formattedQueueId = queueId; // assume string ID (takeaway queues)
        }

        const entry = await db.collection('QueueEntry').findOne({
            userId: new ObjectId(userId),
            queueId: new ObjectId(queueId)
        });

        if (!entry) {
            return res.status(404).json({ message: "Queue entry not found" });
        }

        const position = entry.position;

        // remove user
        await db.collection('QueueEntry').deleteOne({
            _id: entry._id
        });

        // shift everyone behind forward
        await db.collection('QueueEntry').updateMany(
            {
                queueId: new ObjectId(queueId),
                position: { $gt: position }
            },
            {
                $inc: { position: -1 }
            }
        );

        // update timestamp for all remaining users in the queue (trigger frontend refresh and recalculate EWT)
        await db.collection('QueueEntry').updateMany(
            { queueId: formattedQueueId },
            {
                $set: { updatedAt: new Date() }
            }
        );

        res.json({ message: "Left queue successfully" });

    } catch (err) {
        console.error(err);
        res.status(500).send("Error leaving queue");
    }
});

// LEAVE TAKEAWAY QUEUE ------------------------------
app.delete('/leaveTakeawayQueue', async (req, res) => {

    const { ObjectId } = require('mongodb');
    const { userId, queueId } = req.body;

    try {

        const queueObjectId = new require('mongodb').ObjectId(queueId);

        const entry = await db.collection('QueueEntry').findOne({
            userId: new ObjectId(userId),
            queueId: queueObjectId
        });

        if (!entry) {
            return res.status(404).json({ message: "Queue entry not found" });
        }

        // remove user
        await db.collection('QueueEntry').deleteOne({
            _id: entry._id
        });

        // recalculate queue summary
        const updatedCount = await db.collection('QueueEntry').countDocuments({
            queueId: queueObjectId
        });

        const avgServiceTime = 7;
        const totalWaitTime = updatedCount * avgServiceTime;

        await db.collection('Queue').updateOne(
            { _id: queueObjectId },
            {
                $set: {
                    queueLength: updatedCount,
                    estimatedWaitTime: totalWaitTime
                }
            }
        );

        res.json({ message: "Left takeaway queue successfully" });

        // debug logs: verify updated queue summary after leaving takeaway queue
        const updateResult = await db.collection('Queue').updateOne(
            { _id: queueObjectId },
            {
                $set: {
                    queueLength: updatedCount,
                    estimatedWaitTime: totalWaitTime
                }
            }
        );
    } catch (err) {
        console.error(err);
        res.status(500).send("Error leaving takeaway queue");
    }
});

// ACCEPT TABLE AND UPDATE QUEUE ROUTE ------------------------------
app.put('/acceptTable', async (req, res) => {

    if (!db) {
        return res.status(500).send("Database not connected yet");
    }

    const { ObjectId } = require('mongodb');
    const { userId, queueId } = req.body;

    try {
        const entry = await db.collection('QueueEntry').findOne({
            userId: new ObjectId(userId),
            queueId: new ObjectId(queueId)
        });

        if (!entry) {
            return res.status(404).json({ message: "Queue entry not found" });
        }

        const position = entry.position;

        // remove user from queue
        await db.collection('QueueEntry').deleteOne({
            _id: entry._id
        });

        // shift everyone behind forward
        await db.collection('QueueEntry').updateMany(
            {
                queueId: new ObjectId(queueId),
                position: { $gt: position }
            },
            {
                $inc: { position: -1 }
            }
        );

        // update timestamp for all remaining users in the queue to trigger frontend refresh and recalculate EWT
        await db.collection('QueueEntry').updateMany(
            { queueId: formattedQueueId },
            {
                $set: { updatedAt: new Date() }
            }
        );

        res.json({ message: "Table accepted and queue updated" });

    } catch (err) {
        console.error(err);
        res.status(500).send("Error accepting table");
    }
});


// WAIT LONGER (move user to the end of queue) ------------------------------
app.put('/waitLonger', async (req, res) => {

    const { ObjectId } = require('mongodb');
    const { userId, queueId } = req.body;

    try {
        // find user entry
        const userEntry = await db.collection('QueueEntry').findOne({
            userId: new ObjectId(userId),
            queueId: new ObjectId(queueId)
        });

        if (!userEntry) {
            return res.status(404).json({ message: "Queue entry not found" });
        }

        const currentPosition = userEntry.position;

        // get last position in this queue
        const lastUser = await db.collection('QueueEntry')
            .find({ queueId: new ObjectId(queueId) })
            .sort({ position: -1 })
            .limit(1)
            .toArray();

        const lastPosition = lastUser[0]?.position || 1;

        // shift users behind up
        await db.collection('QueueEntry').updateMany(
            {
                queueId: new ObjectId(queueId),
                position: { $gt: currentPosition }
            },
            { $inc: { position: -1 } }
        );

        // move current user to end
        await db.collection('QueueEntry').updateOne(
            { _id: userEntry._id },
            {
                $set: {
                    position: lastPosition,
                    status: "delayed",
                    updatedAt: new Date()
                }
            }
        );

        res.json({ message: "Moved to end of queue" });

    } catch (err) {
        console.error(err);
        res.status(500).send("Error updating queue");
    }
});

// FORFEIT QUEUE ROUTE  ------------------------------
app.delete('/forfeit', async (req, res) => {

  const { ObjectId } = require('mongodb');
  const { userId, queueId } = req.body;

  try {
      await db.collection('QueueEntry').deleteOne({
          userId: new ObjectId(userId),
          queueId: new ObjectId(queueId)
      });

      res.json({ message: "You forfeited your spot" });

  } catch (err) {
      console.error(err);
      res.status(500).send("Error forfeiting queue");
  }
});

// REMOVE SPECIFIC QUEUE ENTRY (for takeaway) -----------------
app.delete('/forfeitQueue', async (req, res) => {

    const { ObjectId } = require('mongodb');
    const { userId, queueId } = req.body;

    try {
        await db.collection('QueueEntry').deleteOne({
            userId: new ObjectId(userId),
            queueId: queueId
        });

        res.json({ message: "Queue removed successfully" });

    } catch (err) {
        console.error(err);
        res.status(500).send("Error removing queue");
    }
});

// GET ALL QUEUE ENTRIES FOR A QUEUE (for admin dashboard to see who's in the queue and their details) ------------------------------
app.get('/queueEntries/:queueId', async (req, res) => {

    const { ObjectId } = require('mongodb');
    const queueId = new ObjectId(req.params.queueId);

    try {
        const entries = await db.collection('QueueEntry')
            .find({
                queueId: queueId,
                status: { $in: ["waiting", "delayed", "ready"] }
            })
            .sort({ position: 1 })
            .toArray();

        res.json(entries);

    } catch (err) {
        console.error(err);
        res.status(500).send("Error fetching queue entries");
    }
});


// GET USER DETAILS BY ID (for admin dashboard to view user details when clicking on a queue entry) ------------------------------
app.get('/user/:id', async (req, res) => {

    const { ObjectId } = require('mongodb');

    const user = await db.collection('users').findOne({
        _id: new ObjectId(req.params.id)
    });

    res.json(user);
});

//app.listen(3000, () => {
    //console.log('Server running on port 3000');
//});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
