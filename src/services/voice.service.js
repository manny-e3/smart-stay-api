import { guestCommand, listRoomDevices } from './controls.service.js';
import { setRoomStatus } from './roomStatus.service.js';
import { createGuestRequest } from './requests.service.js';

/**
 * Voice assistant for the guest app (Google Assistant style). Matches keywords in what the
 * guest said and controls room devices, sets DND or cleaning, opens requests or answers FAQs.
 */

const has = (text, words) => words.some((w) => text.includes(w));

/** Removes "hey google", "please", "can you" and similar from the start. */
function cleanUp(speech) {
  return speech
    .toLowerCase()
    .replace(/^(hey|ok|okay)\s+(google|smartstay|assistant|siri|alexa)[,\s]*/i, '')
    .replace(/^(please|can you|could you|would you|i want to|i'd like to)\s+/i, '')
    .trim();
}

/** Answers for a guest without a room yet. */
function answerWithoutRoom(speech) {
  if (has(speech, ['wifi', 'wi-fi', 'internet'])) return { action: 'info_wifi', speechReply: 'Our complimentary high-speed Wi-Fi is Serene-Luxury-Guest. Simply enter your room number to connect.' };
  if (has(speech, ['breakfast', 'dining'])) return { action: 'info_breakfast', speechReply: 'Breakfast is served daily from 6:30 AM to 10:30 AM at The Palm Terrace on Level 1.' };
  if (has(speech, ['pool', 'gym'])) return { action: 'info_amenities', speechReply: 'The Rooftop Infinity Pool and Fitness Center on Level 4 are open daily from 6:00 AM to 10:00 PM.' };
  return { action: 'no_active_room', speechReply: 'You are not checked into an active room suite yet. Once you link your stay, you can control your lights, climate, and TV via voice!' };
}

async function climate(speech, command, thermostat) {
  const numMatch = speech.match(/\b([1-3][0-9])\b/);
  if (speech.includes('off')) {
    await command(thermostat, { mode: 'off' });
    return { action: 'climate_off', speechReply: 'Air conditioning turned off.' };
  }
  if (speech.includes('eco')) {
    await command(thermostat, { mode: 'eco' });
    return { action: 'climate_eco', speechReply: 'Eco comfort mode activated for your suite climate.' };
  }
  if (numMatch && thermostat) {
    const targetC = parseInt(numMatch[1], 10);
    await command(thermostat, { setpoint: targetC });
    return { action: 'climate_setpoint', speechReply: `I have adjusted your suite climate setpoint to ${targetC}°C.`, executedDetails: { setpoint: targetC } };
  }
  if (has(speech, ['cooler', 'cold', 'lower'])) {
    await command(thermostat, { setpoint: 20 });
    return { action: 'climate_cooler', speechReply: 'Adjusted the room temperature cooler to 20°C.' };
  }
  if (has(speech, ['warmer', 'warm', 'higher'])) {
    await command(thermostat, { setpoint: 24 });
    return { action: 'climate_warmer', speechReply: 'Adjusted the room temperature warmer to 24°C.' };
  }
  await command(thermostat, { mode: 'cool' });
  return { action: 'climate_on', speechReply: 'Suite climate control is active and cooling.' };
}

async function lighting(speech, command, light) {
  if (has(speech, ['off', 'all off'])) {
    await command(light, { on: false });
    return { action: 'lights_off', speechReply: 'All suite lights have been turned off.' };
  }
  if (has(speech, ['cinema', 'movie'])) {
    await command(light, { on: true, brightness: 25 });
    return { action: 'scene_cinema', speechReply: 'Cinema atmosphere mode activated. Lights dimmed to 25% for your screening.' };
  }
  if (speech.includes('relax')) {
    await command(light, { on: true, brightness: 50 });
    return { action: 'scene_relax', speechReply: 'Relaxation ambient scene activated.' };
  }
  if (speech.includes('romantic')) {
    await command(light, { on: true, brightness: 35 });
    return { action: 'scene_romantic', speechReply: 'Romantic mood lighting enabled.' };
  }
  if (has(speech, ['night', 'sleep'])) {
    await command(light, { on: true, brightness: 10 });
    return { action: 'scene_night', speechReply: 'Night mode engaged. Suite lighting dimmed to sleep levels.' };
  }
  const pctMatch = speech.match(/\b([1-9][0-9]?|100)%\b/);
  if (pctMatch && light) {
    const brightness = parseInt(pctMatch[1], 10);
    await command(light, { on: true, brightness });
    return { action: 'lights_dim', speechReply: `Lighting adjusted to ${brightness}% brightness.` };
  }
  await command(light, { on: true });
  return { action: 'lights_on', speechReply: 'Suite lights turned on.' };
}

async function curtains(speech, command, curtain) {
  if (has(speech, ['close', 'shut'])) {
    await command(curtain, { action: 'close' });
    return { action: 'curtains_close', speechReply: 'Closing motorized suite curtains.' };
  }
  await command(curtain, { action: 'open' });
  return { action: 'curtains_open', speechReply: 'Opening motorized curtains to let in natural light.' };
}

async function television(speech, command, tv) {
  if (speech.includes('off')) {
    await command(tv, { power: false });
    return { action: 'tv_off', speechReply: 'Smart TV turned off.' };
  }
  if (speech.includes('mute')) {
    await command(tv, { mute: true });
    return { action: 'tv_mute', speechReply: 'Smart TV audio muted.' };
  }
  if (speech.includes('unmute')) {
    await command(tv, { mute: false });
    return { action: 'tv_unmute', speechReply: 'Smart TV audio unmuted.' };
  }
  await command(tv, { power: true });
  return { action: 'tv_on', speechReply: 'Smart TV powered on.' };
}

/**
 * Handles one spoken command for the signed-in guest.
 * Returns { noRoom: true, action, speechReply } when the guest has no room yet,
 * otherwise { action, speechReply, originalPrompt, executedDetails }.
 */
export async function handleVoiceCommand({ roomId, stayId, guestId }, speechText) {
  const rawSpeech = speechText.trim();
  const speech = cleanUp(rawSpeech);
  if (!roomId) return { noRoom: true, ...answerWithoutRoom(speech) };

  const devices = await listRoomDevices(roomId);
  const ofType = (type) => devices.find((d) => d.type === type);
  // Sends a device command when the room has that device; missing devices are skipped silently.
  const command = async (device, body) => {
    if (device) await guestCommand({ roomId, guestId }, device.id, body);
  };
  const guest = { roomId, stayId, guestId };

  let result;
  if (has(speech, ['temperature', 'temp', 'ac', 'air condition', 'thermostat', 'cooler', 'warmer', 'degrees', 'celsius'])) {
    result = await climate(speech, command, ofType('thermostat'));
  } else if (has(speech, ['light', 'lights', 'lamp', 'scene', 'cinema', 'movie', 'relax', 'romantic', 'night', 'sleep', 'dim', 'bright'])) {
    result = await lighting(speech, command, ofType('light'));
  } else if (has(speech, ['curtain', 'curtains', 'drapes', 'blinds', 'privacy glass', 'frost'])) {
    result = await curtains(speech, command, ofType('curtain'));
  } else if (has(speech, ['tv', 'television', 'netflix', 'spotify', 'volume', 'mute', 'unmute'])) {
    result = await television(speech, command, ofType('tv'));
  } else if (has(speech, ['disturb', 'dnd'])) {
    if (has(speech, ['off', 'cancel', 'disable'])) {
      await setRoomStatus(guest, { dnd: false });
      result = { action: 'dnd_disabled', speechReply: 'Do Not Disturb has been cancelled. Staff may now service your suite.' };
    } else {
      await setRoomStatus(guest, { dnd: true });
      result = { action: 'dnd_enabled', speechReply: 'Do Not Disturb enabled. Front desk and housekeeping have been notified.' };
    }
  } else if (has(speech, ['towel', 'towels', 'pillow', 'pillows', 'blanket', 'toiletries', 'clean', 'housekeeping', 'water', 'porter', 'luggage'])) {
    if (has(speech, ['clean', 'turn down'])) {
      await setRoomStatus(guest, { cleaningRequested: true });
      result = { action: 'cleaning_requested', speechReply: 'Room turnover requested. Housekeeping has received your dispatch.' };
    } else {
      await createGuestRequest({ ...guest, category: 'housekeeping', description: `Voice Command: ${rawSpeech}`, priority: 'normal' });
      result = { action: 'service_dispatched', speechReply: `I have dispatched a request for ${rawSpeech}. An attendant will deliver it to your suite within 10 minutes.` };
    }
  } else if (has(speech, ['wifi', 'wi-fi', 'internet'])) {
    result = { action: 'info_wifi', speechReply: 'The complimentary high-speed Wi-Fi is "Serene-Luxury-Guest". Connect with your room number for 500 Mbps connection.' };
  } else if (has(speech, ['breakfast', 'dining'])) {
    result = { action: 'info_breakfast', speechReply: 'Breakfast is served daily from 6:30 to 10:30 AM at The Palm Terrace on Level 1. In-room dining is also available 24/7.' };
  } else if (has(speech, ['checkout', 'check out'])) {
    result = { action: 'info_checkout', speechReply: 'Standard check-out is at 12:00 PM (Noon). You can request late check-out or express checkout directly in the app.' };
  } else if (has(speech, ['pool', 'gym', 'fitness'])) {
    result = { action: 'info_amenities', speechReply: 'The Rooftop Infinity Pool and Fitness Club are on Level 4, open from 6:00 AM to 10:00 PM daily.' };
  } else {
    result = {
      action: 'ai_fallback',
      speechReply: `I heard: "${rawSpeech}". I have noted your inquiry. You can ask me to adjust the room temperature, toggle lights, order extra towels, or inquire about hotel amenities anytime!`,
    };
  }
  return { action: result.action, speechReply: result.speechReply, originalPrompt: rawSpeech, executedDetails: result.executedDetails ?? null };
}
