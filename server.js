
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const port = Number(process.env.PORT) || 3000;

// Correct frontend path for your current project structure
const frontendPath = path.resolve(__dirname, '..', '..', 'frontend');
const indexPath = path.join(frontendPath, 'index.html');

// Supabase configuration
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;

if (
  supabaseUrl &&
  supabaseKey &&
  !supabaseUrl.includes('YOUR_') &&
  !supabaseKey.includes('YOUR_')
) {
  supabase = createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: false,
    },
  });
}

// Security middleware
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'", 'https://*.supabase.co'],
      },
    },
  })
);

app.use(express.json({ limit: '10kb' }));

// Limit registration attempts
const registrationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: 'Too many registration attempts. Please try again later.',
  },
});

// Disable API caching
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// Database configuration guard
function requireDatabase(req, res, next) {
  if (!supabase) {
    return res.status(503).json({
      error:
        'Database is not configured. Add your Supabase values to backend/.env and restart.',
    });
  }

  next();
}

// Safe database error message
function safeMessage(error) {
  if (error && error.code === '23505') {
    return 'This email is already registered for this event.';
  }

  return 'The database request could not be completed. Check your Supabase setup and try again.';
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    databaseConfigured: Boolean(supabase),
    frontendFound: fs.existsSync(indexPath),
  });
});

// Get all events, with optional search and category filters
app.get('/api/events', requireDatabase, async (req, res, next) => {
  try {
    const search = String(req.query.search || '')
      .trim()
      .slice(0, 80);

    const category = String(req.query.category || '')
      .trim()
      .slice(0, 40);

    let query = supabase
      .from('events')
      .select(
        'id,title,artist,description,category,venue,starts_at,ends_at,capacity,created_at'
      )
      .order('starts_at', { ascending: true });

    if (search) {
      const safeSearch = search.replace(/[,()%]/g, '');

      if (safeSearch) {
        query = query.or(
          `title.ilike.%${safeSearch}%,artist.ilike.%${safeSearch}%,venue.ilike.%${safeSearch}%`
        );
      }
    }

    if (category && category !== 'All styles') {
      query = query.eq('category', category);
    }

    const { data, error } = await query;

    if (error) throw error;

    res.json({ events: data });
  } catch (error) {
    next(error);
  }
});

// Get an event by ID
app.get('/api/events/:id', requireDatabase, async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('events')
      .select(
        'id,title,artist,description,category,venue,starts_at,ends_at,capacity,created_at'
      )
      .eq('id', req.params.id)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(404).json({
        error: 'Event not found.',
      });
    }

    const { count, error: countError } = await supabase
      .from('registrations')
      .select('id', {
        count: 'exact',
        head: true,
      })
      .eq('event_id', req.params.id);

    if (countError) throw countError;

    res.json({
      event: {
        ...data,
        registered_count: count || 0,
      },
    });
  } catch (error) {
    next(error);
  }
});

// Register for an event
app.post(
  '/api/events/:id/registrations',
  registrationLimiter,
  requireDatabase,
  async (req, res, next) => {
    try {
      const { fullName, email, department, studyYear } = req.body || {};

      // Validate name
      if (
        typeof fullName !== 'string' ||
        fullName.trim().length < 2 ||
        fullName.trim().length > 80
      ) {
        return res.status(400).json({
          error: 'Enter a name between 2 and 80 characters.',
        });
      }

      // Validate email
      if (
        typeof email !== 'string' ||
        email.trim().length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
      ) {
        return res.status(400).json({
          error: 'Enter a valid email address.',
        });
      }

      // Validate department
      if (
        department !== undefined &&
        (typeof department !== 'string' ||
          department.trim().length > 80)
      ) {
        return res.status(400).json({
          error: 'Department must be 80 characters or fewer.',
        });
      }

      // Validate study year
      const year = Number(studyYear);

      if (!Number.isInteger(year) || year < 1 || year > 6) {
        return res.status(400).json({
          error: 'Choose a valid study year from 1 to 6.',
        });
      }

      const eventId = req.params.id;

      // Check whether the event exists
      const { data: event, error: eventError } = await supabase
        .from('events')
        .select('id,starts_at,capacity')
        .eq('id', eventId)
        .maybeSingle();

      if (eventError) throw eventError;

      if (!event) {
        return res.status(404).json({
          error: 'Event not found.',
        });
      }

      // Reject registration after the event starts
      if (new Date(event.starts_at) <= new Date()) {
        return res.status(409).json({
          error: 'Registration is closed because this event has started.',
        });
      }

      // Check registration count
      const { count, error: countError } = await supabase
        .from('registrations')
        .select('id', {
          count: 'exact',
          head: true,
        })
        .eq('event_id', eventId);

      if (countError) throw countError;

      if (count >= event.capacity) {
        return res.status(409).json({
          error: 'This event is full.',
        });
      }

      // Insert registration
      const { error } = await supabase.from('registrations').insert({
        event_id: eventId,
        full_name: fullName.trim(),
        email: email.trim().toLowerCase(),
        department: (department || '').trim() || null,
        study_year: year,
      });

      if (error) {
        if (error.code === '23505') {
          return res.status(409).json({
            error: 'This email is already registered for this event.',
          });
        }

        if (error.code === '23503') {
          return res.status(404).json({
            error: 'Event not found.',
          });
        }

        if (error.code === '23514') {
          return res.status(400).json({
            error: 'One of the submitted values is outside the allowed range.',
          });
        }

        throw error;
      }

      return res.status(201).json({
        message: 'You are registered! See you at the event.',
      });
    } catch (error) {
      next(error);
    }
  }
);

// Handle unknown API endpoints
app.use('/api', (req, res) => {
  res.status(404).json({
    error: 'API route not found.',
  });
});

// Serve frontend CSS, JavaScript, images, and other static files
app.use(
  express.static(frontendPath, {
    extensions: ['html'],
  })
);

// Homepage
app.get('/', (req, res) => {
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }

  return res.status(404).send(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Campus Music Portal</title>
      </head>
      <body>
        <h1>Campus Music Portal</h1>
        <p>The backend is running, but the frontend page was not found.</p>
        <p>Expected file: ${indexPath}</p>
        <p>Please check your frontend folder.</p>
      </body>
    </html>
  `);
});

// Handle other unknown routes
app.use((req, res) => {
  res.status(404).send('Page not found.');
});

// Central error handler
app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  if (error instanceof SyntaxError && error.status === 400) {
    return res.status(400).json({
      error: 'Request body must be valid JSON.',
    });
  }

  console.error(
    'Request failed:',
    error && error.message ? error.message : 'unknown error'
  );

  res.status(500).json({
    error: safeMessage(error),
  });
});

// Start server
app.listen(port, () => {
  console.log(`Campus Music Portal is running at http://localhost:${port}`);
  console.log(`Frontend directory: ${frontendPath}`);
  console.log(`Frontend index.html found: ${fs.existsSync(indexPath)}`);
});
