const { pool } = require("../config/db");
const groq = require('./groqService');

class SentimentAnalysisService {
    constructor() {
        if (process.env.GROQ_API_URL) {
            this.provider = 'groq';
            console.log('Sentiment Analysis Service initialized with Groq HTTP provider');
        } else if (process.env.GEMINI_API_KEY) {
            // legacy fallback (unlikely)
            this.provider = 'gemini';
            console.warn('GEMINI_API_KEY found. Legacy Gemini provider path is deprecated.');
        } else {
            this.provider = null;
            console.warn('No sentiment analysis provider configured. Using fallback analysis only.');
        }
    }

    async analyzeFeedback(comments, suggestions, ratings) {
        if (!comments && !suggestions) {
            return this.fallbackAnalysis(ratings);
        }

        if (this.provider === 'groq') {
            try {
                const prompt = this.buildPrompt(comments, suggestions, ratings);
                const res = await groq.analyzeSentiment(prompt);
                if (!res) return this.fallbackAnalysis(ratings);

                // Expecting { sentiment, score } or full structure
                if (res.sentiment && typeof res.score !== 'undefined') {
                    return {
                        sentiment_score: parseFloat(res.score),
                        sentiment_label: res.sentiment,
                        key_themes: res.key_themes || [],
                        requires_urgent_attention: !!res.requires_urgent_attention,
                        aspect_sentiments: res.aspect_sentiments || {},
                        summary: res.summary || ''
                    };
                }

                // If provider returned full analysis object attempt to normalize
                if (res.sentiment_score || res.sentiment_label) {
                    return {
                        sentiment_score: this.validateScore(res.sentiment_score),
                        sentiment_label: this.validateLabel(res.sentiment_label),
                        key_themes: res.key_themes || [],
                        requires_urgent_attention: !!res.requires_urgent_attention,
                        aspect_sentiments: res.aspect_sentiments || {},
                        summary: res.summary || ''
                    };
                }

                return this.fallbackAnalysis(ratings);
            } catch (error) {
                console.error('Groq sentiment API error:', error);
                return this.fallbackAnalysis(ratings);
            }
        }

        return this.fallbackAnalysis(ratings);
    }

    buildPrompt(comments, suggestions, ratings) {
        return `You are a sentiment analysis expert for a waste management service feedback system.

Analyze the following customer feedback and provide a structured JSON response.

FEEDBACK DATA:
- Comments: "${comments || 'N/A'}"
- Suggestions: "${suggestions || 'N/A'}"
- Overall Rating: ${ratings.overall_rating}/5
- Timeliness Rating: ${ratings.timeliness_rating || 'N/A'}/5
- Professionalism Rating: ${ratings.professionalism_rating || 'N/A'}/5
- Cleanliness Rating: ${ratings.cleanliness_rating || 'N/A'}/5

TASK:
1. Determine overall sentiment score from -1.0 (very negative) to 1.0 (very positive)
2. Classify sentiment as: very_negative, negative, neutral, positive, or very_positive
3. Extract 2-5 key themes/topics mentioned (e.g., "late arrival", "rude behavior", "excellent service", "clean work")
4. Identify if urgent action is needed (serious complaints, safety issues, harassment)
5. Detect sentiment about specific aspects: timeliness, professionalism, cleanliness

GUIDELINES:
- Consider both text and ratings
- Ratings of 4-5 usually indicate positive sentiment
- Ratings of 1-2 usually indicate negative sentiment
- Look for strong emotion words (terrible, excellent, disappointed, satisfied)
- Flag urgent if: offensive language, safety concerns, harassment, severe dissatisfaction

Return ONLY valid JSON in this exact format (no markdown, no code blocks):
{
  "sentiment_score": 0.75,
  "sentiment_label": "positive",
  "key_themes": ["punctual", "professional", "thorough cleaning"],
  "requires_urgent_attention": false,
  "aspect_sentiments": {
    "timeliness": "positive",
    "professionalism": "positive",
    "cleanliness": "very_positive"
  },
  "summary": "Customer very satisfied with service quality and driver professionalism"
}`;
    }

    // keep legacy parse function name for compatibility (not used for Groq)
    parseGeminiResponse(text) {
        try {
            let jsonText = text.trim();
            jsonText = jsonText.replace(/```json\n?/g, '');
            jsonText = jsonText.replace(/```\n?/g, '');
            jsonText = jsonText.trim();

            const parsed = JSON.parse(jsonText);

            return {
                sentiment_score: this.validateScore(parsed.sentiment_score),
                sentiment_label: this.validateLabel(parsed.sentiment_label),
                key_themes: Array.isArray(parsed.key_themes)
                    ? parsed.key_themes.slice(0, 10)
                    : [],
                requires_urgent_attention: Boolean(parsed.requires_urgent_attention),
                aspect_sentiments: parsed.aspect_sentiments || {},
                summary: parsed.summary || 'Sentiment analysis completed'
            };
        } catch (error) {
            console.error("Failed to parse Gemini response:", error);
            console.log("Raw response:", text);

            return {
                sentiment_score: 0,
                sentiment_label: 'neutral',
                key_themes: [],
                requires_urgent_attention: false,
                aspect_sentiments: {},
                summary: 'Analysis unavailable - parsing error'
            };
        }
    }

    fallbackAnalysis(ratings) {
        const overallRating = ratings.overall_rating || 3;
        const sentimentScore = ((overallRating - 3) / 2).toFixed(2);

        let sentimentLabel;
        if (overallRating >= 4.5) sentimentLabel = 'very_positive';
        else if (overallRating >= 3.5) sentimentLabel = 'positive';
        else if (overallRating >= 2.5) sentimentLabel = 'neutral';
        else if (overallRating >= 1.5) sentimentLabel = 'negative';
        else sentimentLabel = 'very_negative';

        const aspectSentiments = {};
        if (ratings.timeliness_rating) {
            aspectSentiments.timeliness = this.ratingToSentiment(ratings.timeliness_rating);
        }
        if (ratings.professionalism_rating) {
            aspectSentiments.professionalism = this.ratingToSentiment(ratings.professionalism_rating);
        }
        if (ratings.cleanliness_rating) {
            aspectSentiments.cleanliness = this.ratingToSentiment(ratings.cleanliness_rating);
        }

        return {
            sentiment_score: parseFloat(sentimentScore),
            sentiment_label: sentimentLabel,
            key_themes: ['rating_based_analysis'],
            requires_urgent_attention: overallRating <= 2,
            aspect_sentiments: aspectSentiments,
            summary: `Rating-based analysis: ${overallRating}/5 stars`
        };
    }

    ratingToSentiment(rating) {
        if (rating >= 4.5) return 'very_positive';
        if (rating >= 3.5) return 'positive';
        if (rating >= 2.5) return 'neutral';
        if (rating >= 1.5) return 'negative';
        return 'very_negative';
    }

    validateScore(score) {
        const num = parseFloat(score);
        if (isNaN(num)) return 0;
        if (num < -1) return -1;
        if (num > 1) return 1;
        return parseFloat(num.toFixed(2));
    }

    validateLabel(label) {
        const valid = ['very_negative', 'negative', 'neutral', 'positive', 'very_positive'];
        return valid.includes(label) ? label : 'neutral';
    }

    async getDriverSentimentSummary(driverId, startDate = null, endDate = null) {
        try {
            let dateFilter = '';
            const params = [driverId];

            if (startDate && endDate) {
                dateFilter = 'AND sf.created_at BETWEEN $2 AND $3';
                params.push(startDate, endDate);
            }

            const query = `
        SELECT 
          COUNT(*) as total_feedback,
          AVG(sf.sentiment_score) as avg_sentiment_score,
          AVG(sf.overall_rating) as avg_rating,
          
          SUM(CASE WHEN sf.sentiment_label = 'very_positive' THEN 1 ELSE 0 END) as very_positive_count,
          SUM(CASE WHEN sf.sentiment_label = 'positive' THEN 1 ELSE 0 END) as positive_count,
          SUM(CASE WHEN sf.sentiment_label = 'neutral' THEN 1 ELSE 0 END) as neutral_count,
          SUM(CASE WHEN sf.sentiment_label = 'negative' THEN 1 ELSE 0 END) as negative_count,
          SUM(CASE WHEN sf.sentiment_label = 'very_negative' THEN 1 ELSE 0 END) as very_negative_count,
          
          SUM(CASE WHEN sf.requires_urgent_attention = true THEN 1 ELSE 0 END) as urgent_feedback_count,
          
          jsonb_agg(DISTINCT sf.key_themes) FILTER (WHERE sf.key_themes IS NOT NULL) as all_themes
        FROM service_feedback sf
        WHERE sf.driver_id = $1 
          AND sf.sentiment_score IS NOT NULL
          ${dateFilter}
      `;

            const result = await pool.query(query, params);

            if (result.rows.length === 0 || result.rows[0].total_feedback === '0') {
                return {
                    total_feedback: 0,
                    avg_sentiment_score: null,
                    avg_rating: null,
                    distribution: {
                        very_positive: 0,
                        positive: 0,
                        neutral: 0,
                        negative: 0,
                        very_negative: 0
                    },
                    urgent_feedback_count: 0,
                    common_themes: []
                };
            }

            const data = result.rows[0];

            return {
                total_feedback: parseInt(data.total_feedback, 10),
                avg_sentiment_score: data.avg_sentiment_score ? parseFloat(data.avg_sentiment_score).toFixed(2) : null,
                avg_rating: data.avg_rating ? parseFloat(data.avg_rating).toFixed(2) : null,
                distribution: {
                    very_positive: parseInt(data.very_positive_count, 10),
                    positive: parseInt(data.positive_count, 10),
                    neutral: parseInt(data.neutral_count, 10),
                    negative: parseInt(data.negative_count, 10),
                    very_negative: parseInt(data.very_negative_count, 10)
                },
                urgent_feedback_count: parseInt(data.urgent_feedback_count, 10),
                common_themes: this.extractCommonThemes(data.all_themes)
            };
        } catch (error) {
            console.error('Error getting driver sentiment summary:', error);
            throw error;
        }
    }

    extractCommonThemes(allThemes) {
        if (!allThemes || allThemes.length === 0) return [];

        const themeCount = {};

        allThemes.forEach(themeSet => {
            if (Array.isArray(themeSet)) {
                themeSet.forEach(theme => {
                    if (theme && typeof theme === 'string') {
                        themeCount[theme] = (themeCount[theme] || 0) + 1;
                    }
                });
            }
        });

        return Object.entries(themeCount)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([theme, count]) => ({ theme, count }));
    }

    async getSentimentTrends(groupBy = 'week', limit = 12) {
        try {
            let dateFormat;
            switch (groupBy) {
                case 'day':
                    dateFormat = 'YYYY-MM-DD';
                    break;
                case 'month':
                    dateFormat = 'YYYY-MM';
                    break;
                default:
                    dateFormat = 'YYYY-"W"IW';
            }

            const query = `
        SELECT 
          TO_CHAR(sf.created_at, '${dateFormat}') as period,
          COUNT(*) as feedback_count,
          AVG(sf.sentiment_score) as avg_sentiment,
          AVG(sf.overall_rating) as avg_rating
        FROM service_feedback sf
        WHERE sf.sentiment_score IS NOT NULL
        GROUP BY period
        ORDER BY period DESC
        LIMIT $1
      `;

            const result = await pool.query(query, [limit]);
            return result.rows;
        } catch (error) {
            console.error('Error getting sentiment trends:', error);
            throw error;
        }
    }
}

module.exports = new SentimentAnalysisService();
