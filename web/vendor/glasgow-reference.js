// SPDX-License-Identifier: GPL-3.0-or-later
// Adapted 2026-10-19 for BreathPAPGuardian. Source and changes: THIRD_PARTY_NOTICES.md.
(function(root){
'use strict';
/* 
Copyright 2025 DaveSkvn
This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the
 Free Software Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License along with this program. If not, see <https://www.gnu.org/licenses/>. 
*/


const MILLIS_PER_SAMPLE = 40;
const DETAIL_SAMPLES_SHOW = 1500;
const FLOW_BALANCE_ERROR_PCNT = 20;

const STD_COLOURS = ["#ffffff", "#bab8e0",  "#aca9eb", "#8680ed",  "#090387" ];
const OVERALL_COLOURS = ["#ffffff", "#faacb7",  "#f7798a", "#f7546a",  "#ed0c2a" ];
const BLACK_COLOUR = "#000000";

const MIN_WINDOW = 25;
const GREY_ZONE_LOWER = -10;

// Look for maximum negative (expiration) flow 
function findMins(dataArray){
	for (let ptr = 0; ptr < (MIN_WINDOW) ; ptr++){
// ignore first MIN_WINDOW samples (1 seconds worth)
		dataArray[ptr].min = false;
	}
	
	// look at each flow rate sample in turn
	for(let ptr = MIN_WINDOW; ptr < (dataArray.length - MIN_WINDOW) ; ptr++){
		
		// assume each sample is a minimum
		let minDetected = true;
		for(let winPtr = (ptr - MIN_WINDOW); winPtr < (ptr + MIN_WINDOW -1) ; winPtr++){
			if (dataArray[winPtr].y < dataArray[ptr].y){
				//There is a lower valued sample within one second. Overwrite flag and move on to next sample.
				minDetected = false;
				break;
			}
		}

		if ( (minDetected === true) && (dataArray[ptr].y < GREY_ZONE_LOWER) ){
			// this is the lowest valued sample within 1 second. Flag as a minimum if it is below the "grey zone"
			dataArray[ptr].min = true;
		}else{
			// this is NOT the lowest valued sample within 1 second.
			dataArray[ptr].min = false;
		}
	}
	
	for (let ptr = (dataArray.length - MIN_WINDOW -1 ); ptr < (dataArray.length - 1) ; ptr++){
		// ignore last MIN_WINDOW samples (1 seconds worth)
		dataArray[ptr].min = false;	
	}
}

const TOP_THRESHOLD_PRECENT_90 = 0.9;
const GREY_ZONE_UPPER = 5;

// Look for the inspirations
function findInspirations(dataArray, results){

	results.inspirations = [];
	let ignoreUntil = 0;
	
// look at each sample in turn	
	for(let i = 0; i < dataArray.length - 1; i++){
		if (i < ignoreUntil){ 
// ignore until end of last determined inspiration
			continue;
		}

		if (dataArray[i].y <= GREY_ZONE_UPPER){
			//point is below mid line / grey zone. Ignore and move on 
			dataArray[i].max = false;
			continue;
		}
		
		if ( i === 0 || i === dataArray.length - 1){
			// ignore first and last sample - to avoid explosion on next step			
			dataArray[i].max = false;
			continue;
		}
		
		if ( (dataArray[i-1].y > dataArray[i].y ) || (dataArray[i].y < dataArray[i+1].y) ){
			// Adjacent point is higher - not a max	
			dataArray[i].max = false;
			continue;
		}
		

		let inspirInstance = {};
		// look backwards (from sample i) for the mid line & a higher max
		for(let downPtr = i;  downPtr > 0 ; downPtr-- ){
			if (dataArray[downPtr].y > dataArray[i].y){
// there is a higher point between "sample i" and the mid line (looking backwards) - prob already processed  
				break;	
			}
			if (dataArray[downPtr].y <= GREY_ZONE_UPPER){
// have travelled from sample i to mid line (backwards) without hitting a higher max
				inspirInstance.start = downPtr;
				break;
			}
		}
		if (inspirInstance.start==null){  
			// Did not make it from Sample I to mid line without hitting a higher max - ignore these breaths
			continue;
		}

		// look forwards (from sample i) for the mid line & a higher max
		for(let upPtr = i; upPtr < dataArray.length - 1; upPtr++ ){
			if (dataArray[upPtr].y > dataArray[i].y){
				// there is a higher point between "sample i" and the mid line (looking forwards) - soon to be processed...  
				break;
			}
			if (dataArray[upPtr].y <= GREY_ZONE_UPPER){
				// have travelled from sample i to mid line (forward) without hitting a higher max
				inspirInstance.end = upPtr;
				break;
			}
		}
		if (inspirInstance.end==null){  
			// end of inspiration missing - ignore these breaths
			continue;
		}
		
		if (inspirInstance.end - inspirInstance.start < 8){  
			// ignore inspirations of less than 8 samples (approx 0.4 secs)
			continue;
		}

		// store time text of inspiration and the max value 
		inspirInstance.startTime = dataArray[inspirInstance.start].x;
		inspirInstance.maxValue = dataArray[i].y;
		inspirInstance.midPoint= inspirInstance.start + Math.round( (inspirInstance.end - inspirInstance.start) / 2 );
				
		// set variables for the determination of the characteristics of this inspiration
		let leftVol = 0.0;
		let rightVol = 0.0;
		let top_t90 = 0;
		
		let threshold_90 = inspirInstance.maxValue * TOP_THRESHOLD_PRECENT_90;
		
		inspirInstance.multiPeak = false;
		let firstPeakFound = false;
		let lookingForNextPeak = false;
		let lastMax = 0;
		let lowestPostFirstPeak = 0;
		const MIN_PEAK_BUMP = 1;
		
		for(let ptr = inspirInstance.start; ptr < inspirInstance.end ; ptr++ ){
			// look at each sample between the start and end of the inspiration
			if (ptr < inspirInstance.midPoint){
				// Add all the flow before the mid point together to determine skew  
				leftVol = leftVol + dataArray[ptr].y;
			}else if(ptr > inspirInstance.midPoint){
				// Add all the flow after the mid point together to determine skew  
				rightVol = rightVol + dataArray[ptr].y;
			}
			
			if (dataArray[ptr].y > threshold_90){
				// How many samples were the value above 90% of the maximum (to determine "Top heavy")
				top_t90++;
			}

			// look to see if this inspiration has multiple peaks
			if (firstPeakFound===false){
				// keep looking for a max until one is found then flag "firstPeakFound" to move onto the next state
				if (dataArray[ptr].y > lastMax){
					lastMax = dataArray[ptr].y; 
				}else if (dataArray[ptr].y < lastMax){
					firstPeakFound=true
				}
			}else if ( lookingForNextPeak ===false &&
					(lastMax - dataArray[ptr].y ) > MIN_PEAK_BUMP ){
				// So first peak found. Heading downward. Haven't hit a min yet. Keep track of value looking for a min.
				lookingForNextPeak = true;
				lowestPostFirstPeak = dataArray[ptr].y;
			}if (lookingForNextPeak === true && inspirInstance.multiPeak === false){
				// first peak found, have hit a min and now on way back up. Look for another max above "MIN_PEAK_BUMP" 
				if (dataArray[ptr].y < lowestPostFirstPeak){
					lowestPostFirstPeak = dataArray[ptr].y;
				}else if ( dataArray[ptr].y > (lowestPostFirstPeak + MIN_PEAK_BUMP) ){
					// Have hit one peak, a min and now more than MIN_PEAK_BUMP on the way back up. There's another max coming.
					// Flag and move on.
					inspirInstance.multiPeak = true;
				}
			}
		}
		inspirInstance.leftVol = leftVol;
		inspirInstance.rightVol = rightVol;
		if (inspirInstance.end - inspirInstance.start > 12){
			// only record skew and top heavy for inspirations over 0.5 secs
			inspirInstance.leftPercent = Math.round(10000 * leftVol / (leftVol + rightVol), 2) / 100;
			inspirInstance.top90Percent = Math.round(10000 * top_t90 / (inspirInstance.end  - inspirInstance.start)) / 100;
		}else{
			// set benign values for skew and top heavy for inspirations under 0.5 secs			
			inspirInstance.leftPercent = 50;
			inspirInstance.top90Percent = 32;
		}

		// looking for "Flat Top". Calc variance over the middle 50% of inspiration.
		let varStart = Math.round(inspirInstance.midPoint - ( 0.25 * (inspirInstance.end - inspirInstance.start) ));
		let varEnd = Math.round(inspirInstance.midPoint + ( 0.25 * (inspirInstance.end - inspirInstance.start) ));
		
		let midSum = 0;
		for(let ptr = varStart; ptr < varEnd ; ptr++ ){
			midSum += dataArray[ptr].y;
		}
		
		// calc mean flow value over middle 50% of inspiration 
		let midMean = midSum / ( 0.5 * (inspirInstance.end - inspirInstance.start) );
		let midVar = 0;
		// use mean to calculate variance of flow over middle 50% of inspiration  
		for(let ptr = varStart; ptr < varEnd ; ptr++ ){
			midVar += Math.pow( (midMean - dataArray[ptr].y ), 2);
		}
		//Hold mid inspiration variance to two decimal places
		inspirInstance.midVar =  Math.round(100 * midVar / ( 0.5 * (inspirInstance.end - inspirInstance.start) ) ) / 100;;
		
		results.inspirations.push(inspirInstance);
		ignoreUntil = inspirInstance.end; // only process an inspiration instance once. Ignore multiple peaks at this stage.
	}

}

const EXTRAPOLATION_SAMPLES = 25;

function calcCycleBasedIndicators(dataArray, results){
	let nextInspirIndex = 0;
	
	//Find the sample index IDs of minimums (peak expiration) 
	let minsAtIndex = [];
	for(let i = 0; i < dataArray.length - 1 ; i++){
		if (dataArray[i].min === true){
			minsAtIndex.push(i);
		}
	}
	
	// try to mach up expirations with inspirations and determine their relationship (pause in between?) 
	for(let i = 0; i < minsAtIndex.length - 1; i++){
		//look at each min / peak expiration in turn 
		let indexOfMin = minsAtIndex[i];	
	
		if (nextInspirIndex >= results.inspirations.length ){
			break;
		}

		let emgyBreak = 10;
		do{
			if (emgyBreak-- <= 0 ) {
				console.log("NOT SUPPOSED TO GET HERE"); 
				break;
			}
			if (results.inspirations[nextInspirIndex].start < indexOfMin){
// The "nextInspirIndex" starts before the min/expiration we are looking at. 
// There have been two inspiration curves for one min/expiration. Flag inspiration as "orphaned" and move on.
				results.inspirations[nextInspirIndex].noExhale = true;
				nextInspirIndex++;
			}else if ( ( i < minsAtIndex.length - 1) &&
				results.inspirations[nextInspirIndex].start > minsAtIndex[i+1] ){
// "nextInspirIndex" starts after next min - move to next min...
				break; // to next min
			}else if (results.inspirations[nextInspirIndex].start > indexOfMin){
// The "nextInspirIndex" is after the min we are looking at. Link the two and determine relationship.
				results.inspirations[nextInspirIndex].noExhale = false;
				results.inspirations[nextInspirIndex].linkedMinAt = indexOfMin;
				
				let minValue = dataArray[indexOfMin].y;
				let minValuePlusOneSec = dataArray[indexOfMin+EXTRAPOLATION_SAMPLES].y;
				if (minValuePlusOneSec < 0){
// Expiration is proceeding normally (not complete 1s after peak). Extrapolate where it would intersect with X-axis to determine
// the generated "pre inspiration rest" / pause length.
					let intersection = indexOfMin + Math.round( EXTRAPOLATION_SAMPLES * minValue / (minValue - minValuePlusOneSec) ); 
					results.inspirations[nextInspirIndex].intersection = intersection;
					results.inspirations[nextInspirIndex].preRest = results.inspirations[nextInspirIndex].start - intersection;
				}else{
// inspiration started less than 1s after min. Set default preRest indicating problem (that's too fast for normal breathing).
					results.inspirations[nextInspirIndex].preRest = -10;
				}
				nextInspirIndex++;
				break;
			}else{
				console.log("inspiration neither before nor after selected min!");
			}
		}while (nextInspirIndex < results.inspirations.length - 1)
			
	}
}

const AMP_WINDOW_LEN = 5;

// calculate the variance of the inspiration amplitude - Are the breaths getting stronger and weaker? 
function inspirationAmplitude(dataArray, results){
	
	for(let i = AMP_WINDOW_LEN; i < results.inspirations.length - 1; i++){
		// look at each inspiration (from number "AMP_WINDOW_LEN" onward) 
		let ampMean = 0;
		
		// determine the mean of the max amplitude of these inspiration
		for(let cnt = 0; cnt < AMP_WINDOW_LEN; cnt++){			
			ampMean += results.inspirations[i - cnt].maxValue;
		}
		ampMean = ampMean / AMP_WINDOW_LEN;
		
		let ampVar = 0;
		// Use the mean calcuated to determine the variance of the amplitude
		for(let cnt = 0; cnt < AMP_WINDOW_LEN; cnt++){
			ampVar += Math.pow(results.inspirations[i - cnt].maxValue - ampMean, 2);
		}
		// round to two decimal places 
		ampVar = Math.round( 100 * ampVar / AMP_WINDOW_LEN ) / 100;
		results.inspirations[i].ampVar = ampVar;
		
		// used the time differnce between this inspiration and the inspiration 'AMP_WINDOW_LEN' ago to determine how many
		// inspirations per minute
		let samplesForAveBreaths = results.inspirations[i].start - results.inspirations[i - AMP_WINDOW_LEN].start;
		results.inspirations[i].inspirPerMin = Math.round( (AMP_WINDOW_LEN * 60 * 1000) / (samplesForAveBreaths * MILLIS_PER_SAMPLE) );
	}	
}

// prepare the indices based on the calculated data 
function prepIndices(results){
	// prepare the cumulative indices
	let cumIndex = {};
	cumIndex.skew = 0;
	cumIndex.topHeavy = 0;
	cumIndex.flatTop = 0;
	cumIndex.spike = 0;
	cumIndex.multiPeak = 0;
	cumIndex.noPause = 0;
	cumIndex.inspirRate = 0;
	cumIndex.multiBreath = 0;
	cumIndex.ampVar = 0;
	
	for(const nextInspir of results.inspirations){
		// look at each inspiration in turn. The first few will be incomplete due to the nature of processing. 
		nextInspir.indices = {};
		nextInspir.indices.overall = 0;
		
		if ( (nextInspir.leftPercent < 45) || (nextInspir.leftPercent > 55) ){
// Inspirations with over 55% of the flow volume to the left or right of the mid line are defined as "skewed". 
			nextInspir.indices.skew = true;
			cumIndex.skew++;
			nextInspir.indices.overall++;
		}else{
			nextInspir.indices.skew = false;
		} 
		if ((nextInspir.top90Percent > 40) ){ 
// Where the inspiration spends more than 40% of its time with a value over 90% of the max, it is flagged as "top heavy". 
// Parabola would be 31.6%, sine wave would be 28.7% of the time.
			nextInspir.indices.topHeavy = true;
			cumIndex.topHeavy++;
			nextInspir.indices.overall++;
		}else{
			nextInspir.indices.topHeavy = false;
		} 
		if ((nextInspir.midVar < 0.75) ){ 
// Where the flow rate variance over the mid 50% of the inspiration is low, it is a "flat top".
			nextInspir.indices.flatTop = true;
			cumIndex.flatTop++;
			nextInspir.indices.overall++;
		}else{
			nextInspir.indices.flatTop = false;
		} 

		if ((nextInspir.top90Percent <20) ){ 
// Where the inspiration spends less than 20% of its time with a value over 90% of the max, it is flagged as a "spike". 
// Parabola would be 31.6%, sine wave would be 28.7% of the time.
			nextInspir.indices.spike = true;
			cumIndex.spike++;
			nextInspir.indices.overall++;
		}else{
			nextInspir.indices.spike = false;
		} 
		if (nextInspir.multiPeak ===true){
// If multiple peaks were found on the inspiration (ignoring small bumps), flagged as multipeak.  
			nextInspir.indices.multiPeak = true;
			cumIndex.multiPeak++;
			nextInspir.indices.overall++;
		}else{
			nextInspir.indices.multiPeak = false;
		}
		if (nextInspir.preRest < 10){
//When using the expir. extrapolation above, where the expiration intersects with the x-axis less than 10 samples (0.4 seconds)
//before an inspiration it is flagged as no Pause. Pause normally around 30 samples (1+ secs).
			nextInspir.indices.noPause = true;
			cumIndex.noPause++;
			nextInspir.indices.overall++;
		}else{
			nextInspir.indices.noPause = false;
		}
		if (nextInspir.inspirPerMin > 20){
// Inspiration rate is the number of "inspirations" humps recorded in the flow rate graph per minute. Normal range is 12 to 20.
			nextInspir.indices.inspirRate = true;
			cumIndex.inspirRate++;
			nextInspir.indices.overall++;
		}else{
			nextInspir.indices.inspirRate = false;
		}
		if (nextInspir.noExhale ===true){
// If more than one inspiration "humps" is detected for each expiration min, one or more will be flagged as "multibreath".
// Not seen in normaly breathing.
			nextInspir.indices.multiBreath = true;
			cumIndex.multiBreath++;
			nextInspir.indices.overall++;
		}else{
			nextInspir.indices.multiBreath = false;
		}
		if (nextInspir.ampVar > 4){
// Where the max inspiration amplitude variance is more than 4 the breathing is flagged as unsettled. 			
			nextInspir.indices.ampVar = true;
			cumIndex.ampVar++;
			nextInspir.indices.overall++;
		}else{
			nextInspir.indices.ampVar = false;
		}
	}

// determine the cumulative indices to two decimal places
	cumIndex.skew = Math.round(100 * cumIndex.skew / results.inspirations.length) / 100;
	cumIndex.flatTop = Math.round(100 * cumIndex.flatTop / results.inspirations.length) / 100;
	cumIndex.topHeavy = Math.round(100 * cumIndex.topHeavy / results.inspirations.length) / 100;
	cumIndex.spike = Math.round(100 * cumIndex.spike / results.inspirations.length) / 100;
	cumIndex.multiPeak = Math.round(100 * cumIndex.multiPeak / results.inspirations.length) / 100;
	cumIndex.noPause = Math.round(100 * cumIndex.noPause / results.inspirations.length) / 100;
	cumIndex.inspirRate = Math.round(100 * cumIndex.inspirRate / results.inspirations.length) / 100;
	cumIndex.multiBreath = Math.round(100 * cumIndex.multiBreath / results.inspirations.length) / 100;
	cumIndex.ampVar = Math.round(100 * cumIndex.ampVar / results.inspirations.length) / 100;
	cumIndex.overall = Math.round(100 * (cumIndex.skew + cumIndex.flatTop + cumIndex.spike + cumIndex.multiPeak + cumIndex.noPause +
							cumIndex.inspirRate + cumIndex.multiBreath + cumIndex.ampVar ) ) / 100;
	
	return cumIndex;
}


function analyze(dataArray){
 const results={};
 if(dataArray.length<51||dataArray.every(v=>v.y===dataArray[0].y))return {inspirations:[],cumIndex:null};
 findMins(dataArray);
 findInspirations(dataArray,results);
 if(!results.inspirations.length)return {...results,cumIndex:null};
 calcCycleBasedIndicators(dataArray,results);
 inspirationAmplitude(dataArray,results);
 results.cumIndex=prepIndices(results);
 return results;
}
const api={analyze};
if(typeof module!=='undefined'&&module.exports)module.exports=api;
else root.GlasgowReference=api;
})(globalThis);
