const express = require('express');
const axios = require('axios');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { MongoClient, ObjectId } = require('mongodb');
const { authenticateToken } = require('../middleware/auth');
const env = require('../config/env');
const { sendEmailOtp } = require('../services/otpProvider');
const { assignIndexNumber26 } = require('../services/indexNumberService');
const { generateCandidateQRCode } = require('../services/qrCodeService');

const mongoURI = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB;
const candidateCollection = process.env.MONGODB_COLLECTION;

const COLLECTIONS_TO_CHECK = ['sme26registrations', candidateCollection];

async function findCandidateInCollections(db, query, projection = {}) {
    for (const collName of COLLECTIONS_TO_CHECK) {
        if (!collName) continue;
        const candidate = await db.collection(collName).findOne(query, projection);
        if (candidate) {
            return { candidate, collectionName: collName };
        }
    }
    return { candidate: null, collectionName: null };
}

function getSriLankaTime() {
    const d = new Date();
    const utcTime = d.getTime();
    const slTime = new Date(utcTime + (5.5 * 60 * 60 * 1000));
    return slTime.toISOString().replace('Z', '+05:30');
}

// Backend implementation for MySME API endpoints

// 1. Verify if NIC exists in the database
router.post('/check-nic', async (req, res) => {
    console.log(`[API] /check-nic called for User: ${req.body.email || req.body.NIC}`);
    const { NIC } = req.body;

    if (!NIC) {
        return res.status(400).json({ success: false, message: 'NIC is required' });
    }

    try {
        const client = new MongoClient(mongoURI);
        await client.connect();

        const db = client.db(dbName);
        
        const { candidate } = await findCandidateInCollections(db, { NIC: NIC });

        await client.close();

        if (candidate) {
            // Check if the candidate has a MySME account (has password field)
            const hasMySmeAccount = !!candidate.password;

            // Handle different field names across the different collections
            const firstName = candidate['First Name'] || candidate.firstName || (candidate['Full Name'] ? candidate['Full Name'].split(' ')[0] : '');

            return res.json({
                success: true,
                exists: true,
                hasMySmeAccount: hasMySmeAccount,
                firstName: firstName
            });
        } else {
            // Fallback: Check external API (only when ENABLE_EXTERNAL_API flag is on)
            if (!env.ENABLE_EXTERNAL_API) {
                return res.json({ success: true, exists: false, hasMySmeAccount: false });
            }
            try {
                const externalApiUrl = env.EXTERNAL_SS_QUIZ_API_URL;
                if (!externalApiUrl) {
                    console.error('EXTERNAL_SS_QUIZ_API_URL is not defined in environment variables');
                    return res.status(500).json({
                        success: false,
                        error: "Internal server error: Configuration missing"
                    });
                }

                const externalResponse = await axios.post(`${externalApiUrl}/api/v1/auth/check-nic`, {
                    NIC: NIC
                }, {
                    headers: { 'Content-Type': 'application/json' }
                });

                if (externalResponse.data.success && externalResponse.data.exists) {
                    return res.json({
                        success: true,
                        exists: true,
                        hasMySmeAccount: externalResponse.data.has_password // Map has_password to hasMySmeAccount
                    });
                } else {
                    return res.json({
                        success: true,
                        exists: false,
                        hasMySmeAccount: false
                    });
                }
            } catch (externalError) {
                // If external API returns 400 Bad Request (Validation Error)
                if (externalError.response && externalError.response.status === 400) {
                    return res.status(400).json(externalError.response.data);
                }
                // If external API returns 500 or fails (Server Error)
                console.error('Error checking external NIC:', externalError.message);
                return res.status(500).json({
                    success: false,
                    error: "Internal server error during external verification"
                });
            }
        }
    } catch (error) {
        console.error('Error checking NIC:', error);
        return res.status(500).json({ success: false, message: 'Server error while checking NIC' });
    }
});

// Register a new student for SME26
router.post('/register', async (req, res) => {
    console.log(`[API] /register called for NIC: ${req.body.NIC || req.body.nic}`);
    const firstName = req.body['First Name'] || req.body.firstName;
    const lastName = req.body['Last Name'] || req.body.lastName;
    const emailAddress = req.body['Email Address'] || req.body.emailAddress || req.body.email;
    const NIC = req.body['NIC'] || req.body.nic;
    const whatsappNumber = req.body['WhatsApp Number'] || req.body.whatsappNumber;
    const school = req.body['School'] || req.body.school;
    const alBatch = req.body['AL Batch'] || req.body.alBatch;
    const alAttempt = req.body['AL Attempt'] || req.body.alAttempt;
    const subjectStream = req.body['Subject Stream'] || req.body.subjectStream;
    const medium = req.body['Medium'] || req.body.medium;
    const district = req.body['District'] || req.body.district;
    const preferredExamCenter = req.body['Preferred Exam Center'] || req.body.preferredExamCenter;

    if (!NIC) {
        return res.status(400).json({ success: false, message: 'NIC is required' });
    }

    let client;
    try {
        client = new MongoClient(mongoURI);
        await client.connect();

        const db = client.db(dbName);

        // Check if NIC exists in any collection
        const { candidate: existingCandidate } = await findCandidateInCollections(db, { NIC: NIC });

        if (existingCandidate) {
            return res.status(400).json({
                success: false,
                message: 'This NIC is already registered.'
            });
        }

        const newRegistration = {
            'First Name': firstName,
            'Last Name': lastName,
            'Email Address': emailAddress,
            'NIC': NIC,
            'WhatsApp Number': whatsappNumber,
            'School': school,
            'AL Batch': alBatch,
            'AL Attempt': alAttempt,
            'Subject Stream': subjectStream,
            'Medium': medium,
            'District': district,
            'Preferred Exam Center': preferredExamCenter,
            exam_center_confirmed26: false,
            createdAt: getSriLankaTime()
        };

        await db.collection('sme26registrations').insertOne(newRegistration);

        return res.status(201).json({
            success: true,
            message: 'Registration successful'
        });
    } catch (error) {
        console.error('Error during registration:', error);
        return res.status(500).json({ success: false, message: 'Server error during registration' });
    } finally {
        if (client) {
            await client.close();
        }
    }
});


// Signup for a MySME account
router.post('/signup', async (req, res) => {
    console.log(`[API] /signup called for User: ${req.body.email || req.body.NIC}`);
    const { NIC, password } = req.body;

    if (!NIC || !password) {
        return res.status(400).json({ success: false, message: 'NIC and password are required' });
    }

    try {
        const client = new MongoClient(mongoURI);
        await client.connect();

        const db = client.db(dbName);

        // Check if candidate already exists across all collections
        const { candidate: existingCandidate, collectionName } = await findCandidateInCollections(db, { NIC: NIC });

        // Hash the password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        if (existingCandidate) {
            // If candidate exists but doesn't have a MySME account
            if (existingCandidate.password) {
                await client.close();
                return res.status(400).json({ success: false, message: 'MySME account already exists for this NIC' });
            }

            // Update candidate with password (create MySME account) in the specific collection they were found in
            await db.collection(collectionName).updateOne(
                { NIC: NIC },
                {
                    $set: {
                        password: hashedPassword,
                        lastUpdated: getSriLankaTime()
                    }
                }
            );

            // Create JWT token - Fixed to use consistent casing for NIC
            const token = jwt.sign(
                { 
                    id: existingCandidate._id.toString(), 
                    NIC: existingCandidate.NIC,
                    email: existingCandidate['Email Address'] || existingCandidate.emailAddress || existingCandidate.email 
                },
                env.JWT_SECRET,  // Using env module's JWT_SECRET
                { expiresIn: '24h' }
            );

            await client.close();
            return res.json({
                success: true,
                token,
                candidateId: existingCandidate._id,
                message: 'MySME account created successfully'
            });

        } else {
            // Create new candidate with MySME account
            const newCandidate = {
                NIC,
                password: hashedPassword,
                createdAt: getSriLankaTime(),
                lastUpdated: getSriLankaTime()
            };

            // await collection.insertOne(newCandidate);
            await client.close();

            return res.json({ success: true, message: 'Your NIC is not registered with the exam. Please register first' });
        }
    } catch (error) {
        console.error('Error creating MySME account:', error);
        return res.status(500).json({ success: false, message: 'Server error while creating account' });
    }
});

// Login to MySME account
router.post('/login', async (req, res) => {
    console.log(`[API] /login called for User: ${req.body.email || req.body.NIC}`);
    const { NIC, password } = req.body;

    if (!NIC || !password) {
        return res.status(400).json({ success: false, message: 'NIC and password are required' });
    }

    let client;
    try {
        client = new MongoClient(mongoURI);
        await client.connect();

        const db = client.db(dbName);

        const { candidate } = await findCandidateInCollections(db, { NIC: NIC });

        if (candidate && candidate.password) {
            // Case 1: Local user with password
            const isMatch = await bcrypt.compare(password, candidate.password);

            if (!isMatch) {
                const resetToken = jwt.sign(
                    { 
                        id: candidate._id.toString(), 
                        NIC: candidate.NIC,
                        email: candidate['Email Address'] || candidate.emailAddress || candidate.email,
                        isResetToken: true 
                    },
                    env.JWT_SECRET,
                    { expiresIn: '15m' }
                );
                await client.close();
                return res.status(400).json({ success: false, message: 'Invalid credentials', resetToken });
            }

            // Create JWT token
            const token = jwt.sign(
                { 
                    id: candidate._id.toString(), 
                    NIC: candidate.NIC,
                    email: candidate['Email Address'] || candidate.emailAddress || candidate.email 
                },
                env.JWT_SECRET,
                { expiresIn: '24h' }
            );

            return res.json({
                success: true,
                token,
                candidateId: candidate._id,
            });
        } else {
            // Case 2: User not found locally OR User found but has no local password
            // Fallback: Verify password with external API (only when ENABLE_EXTERNAL_API flag is on)
            if (!env.ENABLE_EXTERNAL_API) {
                await client.close();
                return res.status(401).json({ success: false, message: 'Invalid credentials' });
            }
            try {
                const externalApiUrl = env.EXTERNAL_SS_QUIZ_API_URL;
                if (!externalApiUrl) {
                    console.error('EXTERNAL_SS_QUIZ_API_URL is not defined');
                    await client.close();
                    return res.status(500).json({ success: false, message: 'Configuration error' });
                }

                const externalResponse = await axios.post(`${externalApiUrl}/api/v1/auth/verify-password`, {
                    NIC: NIC,
                    password: password
                }, {
                    headers: { 'Content-Type': 'application/json' }
                });

                if (externalResponse.data.success && externalResponse.data.is_valid) {
                    // Authentication successful via external API
                    // Determine ID: use existing candidate ID or generate a new one
                    const userId = candidate ? candidate._id : new ObjectId();

                    // Create JWT token for regular login
                    const token = jwt.sign(
                        { 
                            id: userId.toString(), 
                            NIC: NIC,
                            email: candidate ? (candidate['Email Address'] || candidate.emailAddress || candidate.email) : null
                        },
                        env.JWT_SECRET,
                        { expiresIn: '24h' }
                    );

                    await client.close();
                    return res.json({
                        success: true,
                        token,
                        candidateId: userId,
                    });
                } else {
                    // External auth failed (invalid password or NIC)
                    const userId = candidate ? candidate._id : new ObjectId();
                    const resetToken = jwt.sign(
                        { id: userId.toString(), NIC: NIC, isResetToken: true },
                        env.JWT_SECRET,
                        { expiresIn: '15m' }
                    );
                    await client.close();
                    return res.status(400).json({ success: false, message: 'Invalid credentials', resetToken });
                }

            } catch (externalError) {
                console.error('Error verifying external password:', externalError.message);
                await client.close();
                // Treat external error as invalid credentials or server error?
                // For security, maybe just invalid credentials or generic error.
                // But if external API is down, user can't login.
                return res.status(500).json({ success: false, message: 'Error verifying credentials externally' });
            }
        }

    } catch (error) {
        console.error('Error logging in:', error);
        return res.status(500).json({ success: false, message: 'Server error while logging in' });
    } finally {
        if (client) {
            await client.close();
        }
    }
});

// Reset candidate password
router.post('/reset-password', authenticateToken, async (req, res) => {
    console.log(`[API] /reset-password called for user: ${req.user.email || req.user.NIC}`);
    // Evaluate whether it's a reset token
    if (!req.user.isResetToken) {
        return res.status(403).json({ success: false, message: 'Invalid token type for password reset. A specific reset token is required.' });
    }

    const { NIC, newPassword } = req.body;

    // Determine the NIC to use (prefer token, fallback to body but must match)
    const targetNIC = req.user.NIC;

    // If frontend sends a NIC that doesn't match the authenticated user, reject it
    if (NIC && NIC !== targetNIC) {
        return res.status(403).json({ success: false, message: 'You can only reset your own password' });
    }

    if (!newPassword) {
        return res.status(400).json({ success: false, message: 'New password is required' });
    }

    let client;
    try {
        client = new MongoClient(mongoURI);
        await client.connect();

        const db = client.db(dbName);

        // Check if candidate exists across all collections
        const { candidate, collectionName } = await findCandidateInCollections(db, { NIC: targetNIC });

        if (!candidate) {
            return res.status(404).json({ success: false, message: 'Candidate not found' });
        }

        if (candidate.usedResetTokens && candidate.usedResetTokens.includes(req.token)) {
            return res.status(403).json({ success: false, message: 'This reset token has already been used' });
        }

        // Hash the new password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);

        // Update password
        await db.collection(collectionName).updateOne(
            { NIC: targetNIC },
            {
                $set: {
                    password: hashedPassword,
                    lastUpdated: getSriLankaTime()
                },
                $push: {
                    usedResetTokens: req.token
                }
            }
        );

        return res.json({ success: true, message: 'Password reset successfully' });
    } catch (error) {
        console.error('Error resetting password:', error);
        return res.status(500).json({ success: false, message: 'Server error while resetting password' });
    } finally {
        if (client) {
            await client.close();
        }
    }
});

// Get candidate profile
router.get('/profile', authenticateToken, async (req, res) => {
    console.log(`[API] /profile called for user: ${req.user.email || req.user.NIC}`);
    let client;
    try {
        client = new MongoClient(mongoURI);
        await client.connect();

        const db = client.db(dbName);

        const { candidate } = await findCandidateInCollections(db, 
            { _id: new ObjectId(req.user.id) },
            {
                projection: {
                    NIC: 1,
                    "Full Name": 1,
                    "First Name": 1,
                    "Last Name": 1,
                    "School ": 1,
                    "School": 1,
                    "Subject Stream": 1,
                    confirmed_papers: 1,
                    qrCodeData: 1,
                    "Preferred Exam Center": 1,
                    final_exam_center: 1,
                    examIndexNumber: 1,
                    examIndexNumber26: 1,
                    qrCode: 1,
                    attended_papers: 1,
                    attended_days: 1,
                    // _id: 1,
                    results_released: 1,
                    check_results_button_clicks_count: 1,
                    exam_center_confirmed26: 1
                }
            }
        );
        let centerLocation = null;
        if (candidate && candidate.exam_center_confirmed26 && candidate.final_exam_center) {
            const centerDoc = await db.collection('sme26examcenters').findOne(
                { center_name: candidate.final_exam_center.trim() },
                { projection: { center_location: 1 } }
            );
            if (centerDoc && centerDoc.center_location) {
                centerLocation = centerDoc.center_location;
            }
        }

        await client.close();
        client = null;

        if (candidate) {
            // Construct Full Name if not present
            if (!candidate["Full Name"]) {
                candidate["Full Name"] = `${candidate["First Name"] || ''} ${candidate["Last Name"] || ''}`.trim();
            }
            
            // Handle School fields (some collections have trailing space, some don't)
            if (!candidate["School "] && candidate["School"]) {
                candidate["School "] = candidate["School"];
            } else if (!candidate["School"] && candidate["School "]) {
                candidate["School"] = candidate["School "];
            }
            
            // Assign examIndexNumber26 to examIndexNumber
            if (candidate.examIndexNumber26) {
                candidate.examIndexNumber = candidate.examIndexNumber26;
            }
            
            if (!candidate.examIndexNumber && !candidate.qrCodeData && !candidate.qrCode) {
                candidate.myExamInfoMessage = "Your Index number and QR code will appear here by 4th of June 6pm";
            }
            
            if (candidate.exam_center_confirmed26 && candidate.final_exam_center) {
                candidate.your_exam_center = centerLocation || candidate.final_exam_center;
            } else {
                candidate.your_exam_center = "Still being finalized. Stay tuned!";
            }

            // Exam center confirmation status
            const examCenterConfirmed = candidate.exam_center_confirmed26 === true;
            candidate.exam_center_confirmed26 = examCenterConfirmed;

            if (!examCenterConfirmed) {
                try {
                    const centersDb = new MongoClient(mongoURI);
                    await centersDb.connect();
                    const examCenters = await centersDb
                        .db(dbName)
                        .collection('sme26examcenters')
                        .find({ is_active: true }, { projection: { center_name: 1, _id: 0 } })
                        .toArray();
                    await centersDb.close();
                    candidate.eligible_exam_centers = examCenters.map(c => c.center_name);
                } catch (centersError) {
                    console.error('Error fetching exam centers:', centersError.message);
                    candidate.eligible_exam_centers = [];
                }
            }
            
            return res.json({ success: true, candidate });
        }

        // Fallback: fetch profile from external API using NIC from JWT token
        // External API: GET /api/v1/auth/profile/{NIC}
        if (!env.ENABLE_EXTERNAL_API) {
            return res.status(404).json({ success: false, message: 'Candidate not found' });
        }

        const candidateNIC = req.user.NIC;
        const externalApiUrl = env.EXTERNAL_SS_QUIZ_API_URL;

        if (!externalApiUrl) {
            console.error('EXTERNAL_SS_QUIZ_API_URL is not defined in environment variables');
            return res.status(404).json({ success: false, message: 'Candidate not found' });
        }

        console.log(`Candidate not found locally, attempting external API fallback for NIC: ${candidateNIC}`);

        try {
            // NIC is a path parameter per the external API contract
            const externalResponse = await axios.get(`${externalApiUrl}/api/v1/auth/profile/${candidateNIC}`, {
                headers: { 'Accept': 'application/json' }
            });

            if (externalResponse.data && externalResponse.data.success && externalResponse.data.data) {
                const d = externalResponse.data.data;

                // Map external snake_case fields to the local candidate shape
                const externalCandidate = {
                    NIC: d.nic,
                    "Full Name": `${d.first_name || ''} ${d.last_name || ''}`.trim(),
                    "School ": d.school,
                    "Subject Stream": d.stream,
                };

                if (!externalCandidate.examIndexNumber && !externalCandidate.qrCodeData && !externalCandidate.qrCode) {
                    externalCandidate.myExamInfoMessage = "Index number and qr code generated will appear here soon.";
                }

                externalCandidate.your_exam_center = "Still being finalized — stay tuned!";

                return res.json({
                    success: true,
                    candidate: externalCandidate,
                    source: 'external'
                });
            } else {
                return res.status(404).json({ success: false, message: 'Candidate not found' });
            }
        } catch (externalError) {
            if (externalError.response && externalError.response.status === 404) {
                return res.status(404).json({ success: false, message: 'Candidate not found' });
            }
            console.error('Error fetching profile from external API:', externalError.message);
            return res.status(500).json({ success: false, message: 'Server error while fetching profile from external source' });
        }

    } catch (error) {
        console.error('Error fetching profile:', error);
        return res.status(500).json({ success: false, message: 'Server error while fetching profile' });
    } finally {
        if (client) {
            await client.close();
        }
    }
});

// Update candidate profile — set final_exam_center (only when exam_center_confirmed26 is false)
router.post('/update_profile', authenticateToken, async (req, res) => {
    console.log(`[API] /update_profile called for user: ${req.user.email || req.user.NIC}`);
    const { final_exam_center } = req.body;

    if (!final_exam_center || typeof final_exam_center !== 'string' || !final_exam_center.trim()) {
        return res.status(400).json({ success: false, message: 'final_exam_center is required and must be a non-empty string.' });
    }

    let client;
    try {
        client = new MongoClient(mongoURI);
        await client.connect();
        const db = client.db(dbName);

        // 1. Validate center name exists in sme26examcenters
        const validCenter = await db.collection('sme26examcenters').findOne(
            { center_name: final_exam_center.trim(), is_active: true },
            { projection: { center_name: 1 } }
        );
        if (!validCenter) {
            return res.status(400).json({ success: false, message: `"${final_exam_center}" is not a valid exam center.` });
        }

        // 2. Find the candidate across collections to check current status and stream
        const { candidate, collectionName } = await findCandidateInCollections(
            db,
            { _id: new ObjectId(req.user.id) },
            { projection: { exam_center_confirmed26: 1, 'Subject Stream': 1, NIC: 1 } }
        );

        if (!candidate) {
            return res.status(404).json({ success: false, message: 'Candidate not found.' });
        }

        // 3. Block update if already confirmed
        if (candidate.exam_center_confirmed26 === true) {
            return res.status(409).json({
                success: false,
                message: 'Exam center has already been confirmed and cannot be changed.'
            });
        }

        // 3.5 Attempt to assign an index number via the service
        const nic = candidate.NIC || req.user.NIC;
        const assignedIndexNumber = await assignIndexNumber26(
            db, 
            final_exam_center, 
            candidate['Subject Stream'], 
            nic
        );

        // 4. Apply the update to the candidate document
        const updateFields = {
            final_exam_center: final_exam_center.trim(),
            exam_center_confirmed26: true,
            exam_center_confirmed26_at: getSriLankaTime()
        };
        
        let qrCodeData = null;
        let qrCode = null;
        
        if (assignedIndexNumber) {
            updateFields.examIndexNumber26 = assignedIndexNumber;
            
            const qrResult = await generateCandidateQRCode(assignedIndexNumber, getSriLankaTime());
            if (qrResult) {
                qrCode = qrResult.qrCode;
                qrCodeData = qrResult.qrCodeData;
                
                updateFields.qrCode = qrResult.qrCode;
                updateFields.qrCodeData = qrResult.qrCodeData;
                updateFields.qrCodeGeneratedAt = qrResult.qrCodeGeneratedAt;
            }
        }

        await db.collection(collectionName).updateOne(
            { _id: new ObjectId(req.user.id) },
            {
                $set: updateFields
            }
        );

        return res.json({
            success: true,
            message: 'Exam center confirmed successfully.',
            final_exam_center: final_exam_center.trim(),
            exam_center_confirmed26: true,
            examIndexNumber26: assignedIndexNumber || undefined,
            qrCode: qrCode || undefined
        });

    } catch (error) {
        console.error('Error in update_profile:', error);
        return res.status(500).json({ success: false, message: 'Server error while updating profile.' });
    } finally {
        if (client) await client.close();
    }
});

// Update candidate survey results
router.post('/update-survey', authenticateToken, async (req, res) => {
    console.log(`[API] /update-survey called for user: ${req.user.email || req.user.NIC}`);
    const {
        extraCurricular,
        achievements,
        volunteeringInterest,
        interests,
        check_results_button_click_complete
    } = req.body;

    // Get NIC from authenticated token instead of request body
    const NIC = req.user.NIC;

    try {
        const client = new MongoClient(mongoURI);
        await client.connect();

        const db = client.db(dbName);

        // Find candidate to know which collection to update
        const { candidate, collectionName } = await findCandidateInCollections(db, { NIC: NIC });

        if (!candidate) {
            return res.status(404).json({
                success: false,
                message: 'Candidate not found'
            });
        }

        // Create update object
        const updateOperation = {
            $set: {
                check_result_survey_results: {
                    survey_extra_curricular: extraCurricular,
                    survey_achievements: achievements,
                    survey_volunteering_interest_ok: volunteeringInterest,
                    survey_volunteering_interests: interests,
                    survey_completed_at: getSriLankaTime(),
                    check_results_button_click_complete: check_results_button_click_complete
                },
            }
        };

        // If click is complete, increment the counter
        if (check_results_button_click_complete) {
            updateOperation.$inc = { check_results_button_clicks_count: 1 };
        }

        const result = await db.collection(collectionName).updateOne(
            { NIC: NIC },
            updateOperation
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({
                success: false,
                message: 'Candidate not found'
            });
        }

        await client.close();
        return res.json({
            success: true,
            message: 'Survey data saved successfully'
        });
    } catch (error) {
        console.error('Error saving survey data:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error while saving survey data'
        });
    }
});

// Get candidate results
router.get('/results', authenticateToken, async (req, res) => {
    console.log(`[API] /results called for user: ${req.user.email || req.user.NIC}`);
    const startTime = Date.now();
    let client;

    try {
        // Get candidate NIC from authenticated token
        const candidateNIC = req.user.NIC;

        client = new MongoClient(mongoURI, {
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 10000
        });

        await client.connect();

        const db = client.db(dbName);

        // Fixed query to use correct field name across collections
        const { candidate: candidateDoc, collectionName } = await findCandidateInCollections(db, { NIC: candidateNIC });

        if (!candidateDoc) {
            console.log(`Candidate not found: ${candidateNIC}`);
            return res.status(404).json({
                success: false,
                message: 'Candidate not found'
            });
        }

        // Check if results are released for this candidate
        if (!candidateDoc.results_released) {
            console.log(`Results not released for candidate: ${candidateNIC}`);
            return res.status(403).json({
                success: false,
                message: 'Results are not yet released for this candidate'
            });
        }

        // Track result check count
        const checkResultsCount = candidateDoc.check_results_button_clicks_count || 0;
        await db.collection(collectionName).updateOne(
            { NIC: candidateNIC },
            {
                $set: {
                    check_results_button_clicks_count: checkResultsCount + 1,
                    last_results_check_at: getSriLankaTime()
                }
            }
        );

        // Determine subject stream to return appropriate grade
        const subjectStream = candidateDoc['Subject Stream'];
        const isBioScience = subjectStream === 'Bio Science';

        const resultsSource = candidateDoc.results_26 || {};

        // Extract only the requested fields based on subject stream
        const filteredResults = {
            district_rank: resultsSource.district_rank || "",
            island_rank: resultsSource.island_rank || "",
            final_zscore: resultsSource.final_zscore || "",
            physics_grade: resultsSource.physics_grade || "",
            chemistry_grade: resultsSource.chemistry_grade || ""
        };

        // Add bio_grade for Bio Science students or maths_grade for Physical Science students
        if (isBioScience) {
            filteredResults.bio_grade = resultsSource.bio_grade || "";
        } else {
            filteredResults.maths_grade = resultsSource.maths_grade || "";
        }

        const duration = Date.now() - startTime;
        console.log(`Results fetched successfully for ${candidateNIC} in ${duration}ms`);

        return res.json({
            success: true,
            results: filteredResults
        });

    } catch (error) {
        const duration = Date.now() - startTime;
        console.error(`Error fetching candidate results (${duration}ms):`, error);

        return res.status(500).json({
            success: false,
            message: 'Server error while fetching results'
        });
    } finally {
        if (client) {
            await client.close();
        }
    }
});

// Get B2B tickets from external SS Quiz API
router.post('/b2b-tickets', authenticateToken, async (req, res) => {
    console.log(`[API] /b2b-tickets called for user: ${req.user.email || req.user.NIC}`);
    const { nic } = req.body;

    if (!nic) {
        return res.status(400).json({ success: false, message: 'nic is required' });
    }

    const externalApiUrl = env.EXTERNAL_SS_QUIZ_API_URL;
    const apiKey = env.EXTERNAL_SS_QUIZ_API_KEY;

    if (!env.ENABLE_EXTERNAL_API) {
        return res.status(503).json({ success: false, message: 'External API is currently disabled' });
    }

    if (!externalApiUrl) {
        console.error('EXTERNAL_SS_QUIZ_API_URL is not defined in environment variables');
        return res.status(500).json({ success: false, message: 'Internal server error: Configuration missing' });
    }

    try {
        const externalResponse = await axios.post(
            `${externalApiUrl}/api/v1/b2b/tickets`,
            { nic },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Key': apiKey || ''
                }
            }
        );

        return res.status(externalResponse.status).json(externalResponse.data);
    } catch (error) {
        if (error.response) {
            // Forward the external API's error response
            return res.status(error.response.status).json(error.response.data);
        }
        console.error('Error calling external B2B tickets API:', error.message);
        return res.status(500).json({ success: false, message: 'Server error while fetching B2B tickets' });
    }
});

// Send OTP to candidate's registered email
router.post('/send-otp', authenticateToken, async (req, res) => {
    console.log(`[API] /send-otp called for user: ${req.user.email || req.user.NIC}`);
    const NIC = req.user.NIC;

    if (!NIC) {
        return res.status(400).json({ success: false, message: 'NIC is missing from token' });
    }

    let client;
    try {
        client = new MongoClient(mongoURI);
        await client.connect();

        const db = client.db(dbName);

        // Find candidate across collections to get their email address
        const { candidate } = await findCandidateInCollections(db, { NIC: NIC });

        if (!candidate) {
            await client.close();
            return res.status(404).json({ success: false, message: 'Candidate with this NIC not found' });
        }

        const email = candidate['Email Address'] || candidate.emailAddress || candidate.email;

        if (!email) {
            await client.close();
            return res.status(400).json({ success: false, message: 'No registered email address found for this candidate' });
        }

        // Generate 6-digit OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes expiration

        // Store OTP in database (upsert to overwrite previous OTPs for this NIC)
        await db.collection('mysme_otps').updateOne(
            { NIC: NIC },
            {
                $set: {
                    NIC: NIC,
                    email: email,
                    otp: otp,
                    expiresAt: expiresAt,
                    used: false,
                    createdAt: new Date()
                }
            },
            { upsert: true }
        );

        await client.close();
        client = null;

        // Send Email
        await sendEmailOtp(email, otp);

        // Obfuscate email for privacy (e.g. ab***@gmail.com)
        const obfuscateEmail = (emailStr) => {
            if (!emailStr) return '';
            const [local, domain] = emailStr.split('@');
            if (!domain) return emailStr;
            const visibleLocal = local.length > 2 ? local.substring(0, 2) + '*'.repeat(local.length - 2) : local + '*';
            return `${visibleLocal}@${domain}`;
        };

        return res.json({
            success: true,
            message: 'OTP sent successfully',
            email: obfuscateEmail(email)
        });

    } catch (error) {
        console.error('Error in send-otp:', error);
        return res.status(500).json({ success: false, message: 'Server error while sending OTP' });
    } finally {
        if (client) {
            await client.close();
        }
    }
});

// Verify candidate OTP and generate password reset token
router.post('/verify-otp', authenticateToken, async (req, res) => {
    console.log(`[API] /verify-otp called for user: ${req.user.email || req.user.NIC}`);
    const NIC = req.user.NIC;
    const { otp } = req.body;

    if (!NIC || !otp) {
        return res.status(400).json({ success: false, message: 'NIC (from token) and OTP are required' });
    }

    let client;
    try {
        client = new MongoClient(mongoURI);
        await client.connect();

        const db = client.db(dbName);

        // Find active OTP record
        const otpRecord = await db.collection('mysme_otps').findOne({
            NIC: NIC,
            otp: otp,
            used: false
        });

        if (!otpRecord) {
            await client.close();
            return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
        }

        // Check expiration
        if (new Date() > new Date(otpRecord.expiresAt)) {
            await client.close();
            return res.status(400).json({ success: false, message: 'OTP has expired. Please request a new one.' });
        }

        // Mark OTP as used
        await db.collection('mysme_otps').updateOne(
            { _id: otpRecord._id },
            { $set: { used: true } }
        );

        // Find candidate details to generate reset token
        const { candidate } = await findCandidateInCollections(db, { NIC: NIC });

        if (!candidate) {
            await client.close();
            return res.status(404).json({ success: false, message: 'Candidate not found' });
        }

        // Generate reset token valid for 15 minutes
        const resetToken = jwt.sign(
            { id: candidate._id.toString(), NIC: candidate.NIC, isResetToken: true },
            env.JWT_SECRET,
            { expiresIn: '15m' }
        );

        await client.close();
        return res.json({
            success: true,
            message: 'OTP verified successfully',
            resetToken: resetToken
        });

    } catch (error) {
        console.error('Error in verify-otp:', error);
        return res.status(500).json({ success: false, message: 'Server error while verifying OTP' });
    } finally {
        if (client) {
            await client.close();
        }
    }
});

module.exports = router;

