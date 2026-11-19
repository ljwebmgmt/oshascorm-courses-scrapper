import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'https://api.groq.com/openai/v1',
  apiKey: process.env.GROQ_API_KEY,
});

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const {
      course_name,
      governing_regulation_citation,
      suggested_duration,
      course_highlights,
      primary_industries,
      regulatory_body,
      course_type,
      course_family
    } = req.body;

    let prompt = `You are a professional instructional writer for an occupational safety training provider. Write course content in professional American English, as plain text only (no HTML, no markdown symbols such as # or *). Use the source information below as your only factual basis.

SOURCE INFORMATION`;

    if (course_name) prompt += `\nCourse name: ${course_name}`;
    if (regulatory_body) prompt += `\nRegulatory body: ${regulatory_body}`;
    if (governing_regulation_citation) prompt += `\nGoverning regulation / citation: ${governing_regulation_citation}`;
    if (course_type) prompt += `\nCourse type: ${course_type}`;
    if (course_family) prompt += `\nCourse family: ${course_family}`;
    if (suggested_duration) prompt += `\nSuggested duration: ${suggested_duration}`;
    if (primary_industries) prompt += `\nPrimary industries: ${primary_industries}`;
    if (course_highlights) prompt += `\nCourse highlights:\n${course_highlights}`;

    prompt += `

OUTPUT FORMAT (use these exact section labels)
Course Description
A comprehensive, detailed description of the course: what it covers, why the topic matters in the workplace, and how it relates to the governing regulation listed above. Be thorough, but prefer accuracy over length.

Learning Objectives
5 to 7 objectives, each on its own line starting with "- " and an action verb, derived only from the course name, citation, and highlights.

Target Audience
The roles and industries this course is suited for, based on the primary industries and course information provided.

STRICT RULES
- Use only the source information above. Do not invent curriculum topics, modules, exercises, or hands-on components that are not supported by it.
- Do not cite any regulation, standard, or section number other than the one provided. Do not offer legal interpretations.
- Do not claim OSHA approval, accreditation, authorization, endorsement, or any certification, card, or certificate outcome.
- Do not guarantee compliance, and do not state that the course satisfies any legal training requirement.
- Do not state or imply that any duration is mandated; if a suggested duration is provided, describe it only as suggested.
- If a source value is missing, omit it; do not guess or fill gaps.
- Output only the three sections, with no preamble, closing remarks, or notes.`;

    const completion = await client.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      messages: [{ role: 'user', content: prompt }],
    });

    const generatedText = completion.choices[0]?.message?.content || '';

    return res.status(200).json({
      success: true,
      content: generatedText
    });

  } catch (error) {
    console.error('Error generating course content:', error);
    return res.status(500).json({ 
      error: 'Failed to generate content',
      message: error.message 
    });
  }
}
