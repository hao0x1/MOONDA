// Landing sites, impact sites, planned landings and places with signs of water ice.
// MADE BY data-prep/sites/make_sites_ts.py from data-prep/sites/sites.json (researched on 14 Nov 2026 from NASA, LROC,
// ISRO, JAXA, CNSA and the lander companies' own pages; see data-prep/sites/NOTES.md) and data-prep/sites/ice-sites.json
// (see data-prep/sites/ICE-NOTES.md). Do not edit by hand: change the source and run the scripts again.
//
//   mission   finished: landers, rovers, sample returns and impact sites
//   active    last reported working by its makers, with no later word either way (shown as "may still be working")
//   planned   announced landings with a published target place; the marker is a region centre, not a touchdown point,
//             and the year is the earliest announced, not a confirmed landing date
//   ice       craters with evidence about water ice: 'confirmed' = water measured there (LCROSS at Cabeus), 'detected' =
//             an instrument in orbit reported signs of possible ice, 'predicted' = possible ice storage from cold/shadow evidence
import type { Place } from './places';

export const SITES: Place[] = [
 {
  "id": "luna-2",
  "kind": "mission",
  "name": "Luna 2",
  "lat": 30,
  "lon": 0,
  "short": "The first human-made object to reach the Moon",
  "detail": "Luna 2 deliberately struck the Moon near the Sea of Rains. This pin shows its broad reported impact area, not a located crater.",
  "date": "13 Sep 1959",
  "source": {
   "name": "Lunar and Planetary Institute: Luna missions",
   "url": "https://www.lpi.usra.edu/lunar/missions/luna/"
  },
  "what": "impact",
  "operator": "Soviet space program",
  "outcome": "success",
  "precisionKm": 50,
  "verify": true,
  "note": "Exact crater not identified. NASA gives a reported area 29–31 N and 1 W–1 E; 30 N, 0 E is its centre. LPI gives another nominal latitude, 29.1 N."
 },
 {
  "id": "ranger-4",
  "kind": "mission",
  "name": "Ranger 4",
  "lat": -15.5,
  "lon": -130.7,
  "short": "The first US spacecraft to reach the Moon",
  "detail": "Ranger 4 failed on the way to the Moon and hit the far side without sending science data. Its exact crater has not been located.",
  "date": "26 Apr 1962",
  "source": {
   "name": "NASA Ranger 4",
   "url": "https://science.nasa.gov/mission/ranger-4/"
  },
  "what": "impact",
  "operator": "NASA",
  "outcome": "failed",
  "precisionKm": 50,
  "verify": true,
  "note": "Approximate tracking-based coordinate only; not in the supplied LROC hardware list."
 },
 {
  "id": "ranger-6",
  "kind": "mission",
  "name": "Ranger 6",
  "lat": 9.3864,
  "lon": 21.4806,
  "short": "A camera probe that hit the Moon without sending pictures",
  "detail": "Ranger 6 struck the Sea of Tranquility as planned, but its cameras failed. Its small impact crater is visible in LROC images.",
  "date": "2 Feb 1964",
  "source": {
   "name": "NASA Ranger 6",
   "url": "https://science.nasa.gov/mission/ranger-6/"
  },
  "what": "impact",
  "operator": "NASA",
  "outcome": "failed",
  "precisionKm": 0.01
 },
 {
  "id": "ranger-7",
  "kind": "mission",
  "name": "Ranger 7",
  "lat": -10.634,
  "lon": -20.677,
  "short": "The first successful US close-up pictures of the Moon",
  "detail": "Ranger 7 sent thousands of close-up pictures before its planned impact. The images helped scientists judge the ground for future landings.",
  "date": "31 Jul 1964",
  "source": {
   "name": "NASA Ranger 7",
   "url": "https://science.nasa.gov/mission/ranger-7/"
  },
  "what": "impact",
  "operator": "NASA",
  "outcome": "success",
  "precisionKm": 0.01
 },
 {
  "id": "ranger-8",
  "kind": "mission",
  "name": "Ranger 8",
  "lat": 2.6377,
  "lon": 24.788,
  "short": "A camera probe that photographed the Sea of Tranquility",
  "detail": "Ranger 8 returned close-up pictures before hitting the Moon as planned. This area later helped planners prepare for Apollo landings.",
  "date": "20 Feb 1965",
  "source": {
   "name": "NASA Ranger 8",
   "url": "https://science.nasa.gov/mission/ranger-8/"
  },
  "what": "impact",
  "operator": "NASA",
  "outcome": "success",
  "precisionKm": 0.01
 },
 {
  "id": "ranger-9",
  "kind": "mission",
  "name": "Ranger 9",
  "lat": -12.8281,
  "lon": -2.3884,
  "short": "A Moon impact broadcast live on television",
  "detail": "Ranger 9 sent pictures of Alphonsus crater as it fell toward the surface. Its planned impact ended the Ranger camera missions.",
  "date": "24 Mar 1965",
  "source": {
   "name": "NASA Ranger 9",
   "url": "https://science.nasa.gov/mission/ranger-9/"
  },
  "what": "impact",
  "operator": "NASA",
  "outcome": "success",
  "precisionKm": 0.01
 },
 {
  "id": "luna-9",
  "kind": "mission",
  "name": "Luna 9",
  "lat": 7.13,
  "lon": -64.37,
  "short": "The first robot to survive a landing on the Moon",
  "detail": "Luna 9 bounced safely to rest and sent the first pictures from the lunar surface. Its exact position has still not been confirmed here.",
  "date": "3 Feb 1966",
  "source": {
   "name": "NASA: Luna 9, first soft lander",
   "url": "https://science.nasa.gov/image-article/apod-1997-september-07-luna-9-first-soft-lander/"
  },
  "what": "lander",
  "operator": "Soviet space program",
  "outcome": "success",
  "precisionKm": 50,
  "verify": true,
  "note": "Historical reported coordinate only. NASA warns LROC images do not match Luna 9 panoramas here and the real site is probably at least 10 km away. Unconfirmed 2026 candidate identifications are not used."
 },
 {
  "id": "surveyor-1",
  "kind": "mission",
  "name": "Surveyor 1",
  "lat": -2.4745,
  "lon": -43.3398,
  "short": "The first US robot to land gently on the Moon",
  "detail": "Surveyor 1 returned thousands of pictures from the Ocean of Storms. It showed engineers that the ground could support a lunar lander.",
  "date": "2 Jun 1966",
  "source": {
   "name": "NASA Surveyor 1",
   "url": "https://science.nasa.gov/mission/surveyor-1/"
  },
  "what": "lander",
  "operator": "NASA",
  "outcome": "success",
  "precisionKm": 0.01
 },
 {
  "id": "luna-13",
  "kind": "mission",
  "name": "Luna 13",
  "lat": 18.87,
  "lon": -62.05,
  "short": "An early robot that tested the Moon's soil",
  "detail": "Luna 13 landed in the Ocean of Storms and returned surface pictures. It also tested how the soil behaves under pressure.",
  "date": "24 Dec 1966",
  "source": {
   "name": "Lunar and Planetary Institute: Luna missions",
   "url": "https://www.lpi.usra.edu/lunar/missions/luna/"
  },
  "what": "lander",
  "operator": "Soviet space program",
  "outcome": "success",
  "precisionKm": 30,
  "verify": true,
  "note": "Reported landing coordinate, not a confirmed LROC hardware location; 30 km is a conservative display uncertainty, not a published statistical error."
 },
 {
  "id": "surveyor-3",
  "kind": "mission",
  "name": "Surveyor 3",
  "lat": -3.0162,
  "lon": -23.418,
  "short": "A robot later visited by Apollo 12 astronauts",
  "detail": "Surveyor 3 photographed the ground and dug small trenches. Apollo 12 astronauts later visited it and returned some parts to Earth.",
  "date": "20 Apr 1967",
  "source": {
   "name": "NASA Surveyor 3",
   "url": "https://science.nasa.gov/mission/surveyor-3/"
  },
  "what": "lander",
  "operator": "NASA",
  "outcome": "success",
  "precisionKm": 0.01
 },
 {
  "id": "surveyor-5",
  "kind": "mission",
  "name": "Surveyor 5",
  "lat": 1.4551,
  "lon": 23.1942,
  "short": "A robot that tested what Moon soil is made of",
  "detail": "Surveyor 5 landed in the Sea of Tranquility after surviving a helium leak. It measured the soil and sent back more than 20,000 pictures.",
  "date": "11 Sep 1967",
  "source": {
   "name": "NASA Surveyor 5",
   "url": "https://science.nasa.gov/mission/surveyor-5/"
  },
  "what": "lander",
  "operator": "NASA",
  "outcome": "success",
  "precisionKm": 0.01
 },
 {
  "id": "surveyor-6",
  "kind": "mission",
  "name": "Surveyor 6",
  "lat": 0.4743,
  "lon": -1.4275,
  "short": "A Moon robot that made a small rocket-powered hop",
  "detail": "Surveyor 6 landed in the Central Bay and studied the soil. It later fired its engines and hopped to a nearby spot.",
  "date": "10 Nov 1967",
  "source": {
   "name": "NASA Surveyor 6",
   "url": "https://science.nasa.gov/mission/surveyor-6/"
  },
  "what": "lander",
  "operator": "NASA",
  "outcome": "success",
  "precisionKm": 0.01
 },
 {
  "id": "surveyor-7",
  "kind": "mission",
  "name": "Surveyor 7",
  "lat": -40.9811,
  "lon": -11.5127,
  "short": "The last Surveyor, beside the bright Tycho crater",
  "detail": "Surveyor 7 landed on rough ground north of Tycho. Its pictures and soil tests let scientists compare the highlands with earlier flat landing sites.",
  "date": "10 Jan 1968",
  "source": {
   "name": "NASA Surveyor 7",
   "url": "https://science.nasa.gov/mission/surveyor-7/"
  },
  "what": "lander",
  "operator": "NASA",
  "outcome": "success",
  "precisionKm": 0.01
 },
 {
  "id": "m-apollo11",
  "kind": "mission",
  "name": "Apollo 11",
  "lat": 0.67416,
  "lon": 23.47314,
  "short": "The first place people walked on the Moon",
  "detail": "Neil Armstrong and Buzz Aldrin landed Eagle in the Sea of Tranquility. Their descent stage and footprints remain here.",
  "date": "20 Jul 1969",
  "source": {
   "name": "NASA Apollo 11",
   "url": "https://www.nasa.gov/mission/apollo-11/"
  },
  "what": "crewed",
  "operator": "NASA",
  "outcome": "success",
  "precisionKm": 0.01
 },
 {
  "id": "m-apollo12",
  "kind": "mission",
  "name": "Apollo 12",
  "lat": -3.0128,
  "lon": -23.4219,
  "short": "Astronauts landed beside an older robot",
  "detail": "Pete Conrad and Alan Bean made a precise landing in the Ocean of Storms. They walked to Surveyor 3 and brought parts of it home.",
  "date": "19 Nov 1969",
  "source": {
   "name": "NASA Apollo 12",
   "url": "https://www.nasa.gov/mission/apollo-12/"
  },
  "what": "crewed",
  "operator": "NASA",
  "outcome": "success",
  "precisionKm": 0.01
 },
 {
  "id": "apollo-12-ascent-impact",
  "kind": "mission",
  "name": "Apollo 12 ascent-stage impact",
  "lat": -3.9195,
  "lon": -21.1721,
  "short": "An empty Moon cabin crashed here for a science test",
  "detail": "After its astronauts returned to lunar orbit, Apollo 12's empty ascent stage hit the Moon. The shaking was recorded by surface instruments.",
  "date": "20 Nov 1969",
  "source": {
   "name": "NASA Apollo 12",
   "url": "https://www.nasa.gov/mission/apollo-12/"
  },
  "what": "impact",
  "operator": "NASA",
  "outcome": "success",
  "precisionKm": 0.01
 },
 {
  "id": "apollo-13-rocket-impact",
  "kind": "mission",
  "name": "Apollo 13 rocket impact",
  "lat": -2.555,
  "lon": -27.8875,
  "short": "A rocket stage crashed here to shake the Moon",
  "detail": "Apollo 13's spent Saturn V third stage hit the Moon on purpose. Instruments left by astronauts measured the shaking to learn about the lunar interior.",
  "date": "15 Apr 1970",
  "source": {
   "name": "NASA Apollo 13",
   "url": "https://www.nasa.gov/mission/apollo-13/"
  },
  "what": "impact",
  "operator": "NASA",
  "outcome": "success",
  "precisionKm": 0.01,
  "note": "Date uses UTC (NASA NSSDCA impact table); some US-local descriptions give the previous calendar day."
 },
 {
  "id": "luna-16",
  "kind": "mission",
  "name": "Luna 16",
  "lat": -0.5137,
  "lon": 56.3638,
  "short": "The first robot to bring Moon soil back to Earth",
  "detail": "Luna 16 landed in the Sea of Fertility and drilled into the dark ground. Its small return rocket carried about 101 grams of soil to Earth.",
  "date": "20 Sep 1970",
  "source": {
   "name": "NASA: Luna 16 sample-return landing",
   "url": "https://science.nasa.gov/photojournal/luna-16/"
  },
  "what": "sample-return",
  "operator": "Soviet space program",
  "outcome": "success",
  "precisionKm": 0.01
 },
 {
  "id": "luna-17",
  "kind": "mission",
  "name": "Luna 17",
  "lat": 38.23764,
  "lon": -35.00163,
  "short": "The lander that carried the first Moon rover",
  "detail": "Luna 17 landed in the Sea of Rains and lowered ramps. Lunokhod 1 drove off and began the first long rover trip on another world.",
  "date": "17 Nov 1970",
  "source": {
   "name": "LROC: Lunokhod 1 Revisited",
   "url": "https://lroc.im-ldi.com/images/402"
  },
  "what": "lander",
  "operator": "Soviet space program",
  "outcome": "success",
  "precisionKm": 0.01
 },
 {
  "id": "lunokhod-1",
  "kind": "mission",
  "name": "Lunokhod 1",
  "lat": 38.31517,
  "lon": -35.00798,
  "short": "The first remote-controlled rover on another world",
  "detail": "Lunokhod 1 drove more than 10 kilometres across the Sea of Rains. This pin marks where the rover finally stopped.",
  "date": "17 Nov 1970",
  "source": {
   "name": "LROC: Lunokhod 1 mission and site",
   "url": "https://lroc.im-ldi.com/featured_sites/lunokhod-1/flip-book"
  },
  "what": "rover",
  "operator": "Soviet space program",
  "outcome": "success",
  "precisionKm": 0.01,
  "note": "Date is arrival aboard Luna 17; coordinates are the final rover position from laser ranging. A passive reflector does not make the rover an active powered mission."
 },
 {
  "id": "apollo-14-rocket-impact",
  "kind": "mission",
  "name": "Apollo 14 rocket impact",
  "lat": -8.181,
  "lon": -26.0305,
  "short": "A rocket stage crashed here to shake the Moon",
  "detail": "Apollo 14's spent Saturn V third stage hit the Moon on purpose. Instruments left by astronauts measured the shaking to learn about the lunar interior.",
  "date": "4 Feb 1971",
  "source": {
   "name": "NASA Apollo 14",
   "url": "https://www.nasa.gov/mission/apollo-14/"
  },
  "what": "impact",
  "operator": "NASA",
  "outcome": "success",
  "precisionKm": 0.01,
  "note": "Date uses UTC (NASA NSSDCA impact table); some US-local descriptions give the previous calendar day."
 },
 {
  "id": "m-apollo14",
  "kind": "mission",
  "name": "Apollo 14",
  "lat": -3.64589,
  "lon": -17.47194,
  "short": "Astronauts explored the rocky Fra Mauro hills",
  "detail": "Alan Shepard and Edgar Mitchell landed in the Fra Mauro highlands. They collected rocks thrown out by an ancient giant impact.",
  "date": "5 Feb 1971",
  "source": {
   "name": "NASA Apollo 14",
   "url": "https://www.nasa.gov/mission/apollo-14/"
  },
  "what": "crewed",
  "operator": "NASA",
  "outcome": "success",
  "precisionKm": 0.01
 },
 {
  "id": "apollo-15-rocket-impact",
  "kind": "mission",
  "name": "Apollo 15 rocket impact",
  "lat": -1.2897,
  "lon": -11.8245,
  "short": "A rocket stage crashed here to shake the Moon",
  "detail": "Apollo 15's spent Saturn V third stage hit the Moon on purpose. Instruments left by astronauts measured the shaking to learn about the lunar interior.",
  "date": "29 Jul 1971",
  "source": {
   "name": "NASA Apollo 15",
   "url": "https://www.nasa.gov/mission/apollo-15/"
  },
  "what": "impact",
  "operator": "NASA",
  "outcome": "success",
  "precisionKm": 0.01,
  "note": "Date uses UTC (NASA NSSDCA impact table); some US-local descriptions give the previous calendar day."
 },
 {
  "id": "m-apollo15",
  "kind": "mission",
  "name": "Apollo 15",
  "lat": 26.13239,
  "lon": 3.6333,
  "short": "The first astronauts to drive a Moon rover",
  "detail": "David Scott and James Irwin explored beside the Apennine mountains and Hadley Rille. A rover let them travel much farther than earlier crews.",
  "date": "30 Jul 1971",
  "source": {
   "name": "NASA Apollo 15",
   "url": "https://www.nasa.gov/mission/apollo-15/"
  },
  "what": "crewed",
  "operator": "NASA",
  "outcome": "success",
  "precisionKm": 0.01
 },
 {
  "id": "apollo-15-rover",
  "kind": "mission",
  "name": "Apollo 15 rover",
  "lat": 26.13174,
  "lon": 3.63803,
  "short": "An astronaut-driven Moon rover, parked for good",
  "detail": "This is the parked rover from Apollo 15. LROC images show its location separately from the nearby lunar module.",
  "date": "30 Jul 1971",
  "source": {
   "name": "NASA Apollo 15",
   "url": "https://www.nasa.gov/mission/apollo-15/"
  },
  "what": "rover",
  "operator": "NASA",
  "outcome": "success",
  "precisionKm": 0.01,
  "note": "Date is arrival aboard the lunar module; coordinates mark the final parked rover, not the touchdown point."
 },
 {
  "id": "luna-20",
  "kind": "mission",
  "name": "Luna 20",
  "lat": 3.7863,
  "lon": 56.6242,
  "short": "A robot that brought highland soil back to Earth",
  "detail": "Luna 20 landed in rugged hills between two dark lava plains. It returned about 55 grams of soil for scientists to study.",
  "date": "21 Feb 1972",
  "source": {
   "name": "LROC: Luna 20 mission and site",
   "url": "https://lroc.im-ldi.com/featured_sites/luna-20/flip-book"
  },
  "what": "sample-return",
  "operator": "Soviet space program",
  "outcome": "success",
  "precisionKm": 0.01
 },
 {
  "id": "apollo-16-rocket-impact",
  "kind": "mission",
  "name": "Apollo 16 rocket impact",
  "lat": 1.9213,
  "lon": -24.6231,
  "short": "A rocket stage crashed here to shake the Moon",
  "detail": "Apollo 16's spent Saturn V third stage hit the Moon on purpose. Instruments left by astronauts measured the shaking to learn about the lunar interior.",
  "date": "19 Apr 1972",
  "source": {
   "name": "NASA Apollo 16",
   "url": "https://www.nasa.gov/mission/apollo-16/"
  },
  "what": "impact",
  "operator": "NASA",
  "outcome": "success",
  "precisionKm": 0.0112,
  "note": "Date uses UTC (NASA NSSDCA impact table); some US-local descriptions give the previous calendar day."
 },
 {
  "id": "m-apollo16",
  "kind": "mission",
  "name": "Apollo 16",
  "lat": -8.9734,
  "lon": 15.5011,
  "short": "A rover trip through the Moon's bright highlands",
  "detail": "John Young and Charles Duke explored the Descartes highlands. Their rocks showed that impacts shaped much of this bright, rough ground.",
  "date": "21 Apr 1972",
  "source": {
   "name": "NASA Apollo 16",
   "url": "https://www.nasa.gov/mission/apollo-16/"
  },
  "what": "crewed",
  "operator": "NASA",
  "outcome": "success",
  "precisionKm": 0.01
 },
 {
  "id": "apollo-16-rover",
  "kind": "mission",
  "name": "Apollo 16 rover",
  "lat": -8.9729,
  "lon": 15.5037,
  "short": "An astronaut-driven Moon rover, parked for good",
  "detail": "This is the parked rover from Apollo 16. LROC images show its location separately from the nearby lunar module.",
  "date": "21 Apr 1972",
  "source": {
   "name": "NASA Apollo 16",
   "url": "https://www.nasa.gov/mission/apollo-16/"
  },
  "what": "rover",
  "operator": "NASA",
  "outcome": "success",
  "precisionKm": 0.01,
  "note": "Date is arrival aboard the lunar module; coordinates mark the final parked rover, not the touchdown point."
 },
 {
  "id": "apollo-17-rocket-impact",
  "kind": "mission",
  "name": "Apollo 17 rocket impact",
  "lat": -4.1681,
  "lon": -12.3307,
  "short": "A rocket stage crashed here to shake the Moon",
  "detail": "Apollo 17's spent Saturn V third stage hit the Moon on purpose. Instruments left by astronauts measured the shaking to learn about the lunar interior.",
  "date": "10 Dec 1972",
  "source": {
   "name": "NASA Apollo 17",
   "url": "https://www.nasa.gov/mission/apollo-17/"
  },
  "what": "impact",
  "operator": "NASA",
  "outcome": "success",
  "precisionKm": 0.01,
  "note": "Date uses UTC (NASA NSSDCA impact table); some US-local descriptions give the previous calendar day."
 },
 {
  "id": "m-apollo17",
  "kind": "mission",
  "name": "Apollo 17",
  "lat": 20.1911,
  "lon": 30.7723,
  "short": "The final Apollo landing, in a mountain valley",
  "detail": "Gene Cernan and geologist Harrison Schmitt explored Taurus-Littrow valley. They drove a rover and collected orange volcanic soil.",
  "date": "11 Dec 1972",
  "source": {
   "name": "NASA Apollo 17",
   "url": "https://www.nasa.gov/mission/apollo-17/"
  },
  "what": "crewed",
  "operator": "NASA",
  "outcome": "success",
  "precisionKm": 0.01
 },
 {
  "id": "apollo-17-rover",
  "kind": "mission",
  "name": "Apollo 17 rover",
  "lat": 20.1896,
  "lon": 30.7769,
  "short": "An astronaut-driven Moon rover, parked for good",
  "detail": "This is the parked rover from Apollo 17. LROC images show its location separately from the nearby lunar module.",
  "date": "11 Dec 1972",
  "source": {
   "name": "NASA Apollo 17",
   "url": "https://www.nasa.gov/mission/apollo-17/"
  },
  "what": "rover",
  "operator": "NASA",
  "outcome": "success",
  "precisionKm": 0.01,
  "note": "Date is arrival aboard the lunar module; coordinates mark the final parked rover, not the touchdown point."
 },
 {
  "id": "luna-21",
  "kind": "mission",
  "name": "Luna 21",
  "lat": 25.9994,
  "lon": 30.4076,
  "short": "The lander that carried Lunokhod 2",
  "detail": "Luna 21 landed on the floor of Le Monnier crater. Its ramps let Lunokhod 2 roll down to explore the nearby plain and hills.",
  "date": "15 Jan 1973",
  "source": {
   "name": "LROC: Luna 21 Lander",
   "url": "https://lroc.im-ldi.com/images/15"
  },
  "what": "lander",
  "operator": "Soviet space program",
  "outcome": "success",
  "precisionKm": 0.0134
 },
 {
  "id": "lunokhod-2",
  "kind": "mission",
  "name": "Lunokhod 2",
  "lat": 25.83232,
  "lon": 30.92215,
  "short": "A rover that drove about 39 kilometres",
  "detail": "Lunokhod 2 explored Le Monnier crater for several months. This pin marks the rover's final resting place after it stopped working.",
  "date": "15 Jan 1973",
  "source": {
   "name": "LROC: Trundling Across the Moon",
   "url": "https://lroc.im-ldi.com/images/774"
  },
  "what": "rover",
  "operator": "Soviet space program",
  "outcome": "success",
  "precisionKm": 0.01,
  "note": "Date is arrival aboard Luna 21; rover deployment was 1973-01-16 UTC. Coordinates are the final rover position from laser ranging; passive reflector use is not powered operation."
 },
 {
  "id": "luna-23",
  "kind": "mission",
  "name": "Luna 23",
  "lat": 12.6667,
  "lon": 62.1511,
  "short": "A sample-return robot that could not collect soil",
  "detail": "Luna 23 reached the Sea of Crises but could not collect a sample. The whole spacecraft remains on the surface near Luna 24.",
  "date": "6 Nov 1974",
  "source": {
   "name": "LROC: Luna 23 mission and site",
   "url": "https://lroc.im-ldi.com/featured_sites/luna-23/flip-book"
  },
  "what": "sample-return",
  "operator": "Soviet space program",
  "outcome": "partial",
  "precisionKm": 0.01
 },
 {
  "id": "luna-24",
  "kind": "mission",
  "name": "Luna 24",
  "lat": 12.7142,
  "lon": 62.2129,
  "short": "The last Soviet robot to bring Moon soil home",
  "detail": "Luna 24 drilled into the Sea of Crises and returned about 170 grams of soil. Its landing stage remains near the earlier Luna 23 spacecraft.",
  "date": "18 Aug 1976",
  "source": {
   "name": "LROC: Luna 24 mission and site",
   "url": "https://lroc.im-ldi.com/featured_sites/luna-24/flip-book"
  },
  "what": "sample-return",
  "operator": "Soviet space program",
  "outcome": "success",
  "precisionKm": 0.01
 },
 {
  "id": "hiten-impact",
  "kind": "mission",
  "name": "Hiten impact",
  "lat": -34.3,
  "lon": 55.6,
  "short": "Japan's first Moon probe ended here",
  "detail": "Hiten tested ways to reach and orbit the Moon. It finished its mission with a planned impact near Furnerius crater.",
  "date": "10 Apr 1993",
  "source": {
   "name": "JAXA DARTS: Hiten",
   "url": "https://darts.isas.jaxa.jp/en/missions/hiten"
  },
  "what": "impact",
  "operator": "ISAS (now JAXA)",
  "outcome": "success",
  "precisionKm": 10,
  "verify": true,
  "note": "JAXA gives an estimated position; no identified crater or documented ME registration. UTC impact date is April 10, while Japan-local histories say April 11."
 },
 {
  "id": "lunar-prospector-impact",
  "kind": "mission",
  "name": "Lunar Prospector impact",
  "lat": -87.7,
  "lon": 42,
  "short": "A deliberate impact in a dark south-pole crater",
  "detail": "Lunar Prospector mapped the Moon before hitting Shoemaker crater. Scientists looked for water in the impact cloud but did not detect it.",
  "date": "31 Jul 1999",
  "source": {
   "name": "NASA Lunar Prospector",
   "url": "https://science.nasa.gov/mission/lunar-prospector/"
  },
  "what": "impact",
  "operator": "NASA",
  "outcome": "success",
  "precisionKm": 5,
  "verify": true,
  "note": "NASA NSSDCA approximate impact coordinate, not a located crater. Planetocentric ME registration of the old estimate is not established."
 },
 {
  "id": "smart-1-impact",
  "kind": "mission",
  "name": "SMART-1 impact",
  "lat": -34.262,
  "lon": -46.193,
  "short": "Europe's first Moon probe left a long scrape",
  "detail": "SMART-1 tested electric propulsion and studied the Moon from orbit. Its planned shallow impact left a gouge about 20 metres long.",
  "date": "3 Sep 2006",
  "source": {
   "name": "ESA: impact ends SMART-1 mission",
   "url": "https://www.esa.int/Newsroom/Press_Releases/Impact_landing_ends_SMART-1_mission_to_the_Moon"
  },
  "what": "impact",
  "operator": "NASA",
  "outcome": "success",
  "precisionKm": 0.1,
  "note": "ESA reports an LROC-located gouge. Not present in supplied QuickMap anthropogenic file; 0.1 km is conservative because the ESA article does not publish formal coordinate error."
 },
 {
  "id": "chandrayaan-1-mip",
  "kind": "mission",
  "name": "Chandrayaan-1 Moon Impact Probe",
  "lat": -89.55,
  "lon": -122.93,
  "short": "India's first Moon impact probe, likely near a south-pole ridge",
  "detail": "The probe sent pictures and measurements while falling toward the Moon. Researchers matched its last pictures to maps to estimate where it hit.",
  "date": "14 Nov 2008",
  "source": {
   "name": "NASA: Chandrayaan-1 / Moon Impact Probe",
   "url": "https://science.nasa.gov/mission/chandrayaan-1/"
  },
  "what": "impact",
  "operator": "ISRO",
  "outcome": "success",
  "precisionKm": 2,
  "verify": true,
  "note": "Estimated impact point from the final descent pictures, not a crater located in LROC imagery. Authors give near 89.55 S, 122.93 W and say the crater/ejecta has not been found; 2 km is a conservative display uncertainty, not a published error bar. This supersedes widely repeated legacy estimates near 89.76 S, 39.40 W."
 },
 {
  "id": "change-1-impact",
  "kind": "mission",
  "name": "Chang'e-1 impact",
  "lat": -1.5,
  "lon": 52.36,
  "short": "China's first Moon mapper ended with a planned impact",
  "detail": "Chang'e-1 mapped the Moon from orbit for about 16 months. Its controlled impact helped prepare China for later landings.",
  "date": "1 Mar 2009",
  "source": {
   "name": "NASA: 2009 chronology, March 1",
   "url": "https://www.nasa.gov/wp-content/uploads/2023/03/sp4035.pdf"
  },
  "what": "impact",
  "operator": "CNSA",
  "outcome": "success",
  "precisionKm": 5,
  "verify": true,
  "note": "Reported impact point from NASA NSSDCA; not identified as hardware/crater in the supplied QuickMap list and no ME frame tie confirmed."
 },
 {
  "id": "kaguya-impact",
  "kind": "mission",
  "name": "Kaguya impact",
  "lat": -65.5,
  "lon": 80.4,
  "short": "Japan's large Moon mapper ended with an impact",
  "detail": "Kaguya mapped the Moon's shape and composition from orbit. It ended with a controlled impact near Gill crater.",
  "date": "10 Jun 2009",
  "source": {
   "name": "JAXA: Kaguya lunar impact",
   "url": "https://www.kaguya.jaxa.jp/en/communication/KAGUYA_Lunar_Impact_e.htm"
  },
  "what": "impact",
  "operator": "JAXA",
  "outcome": "success",
  "precisionKm": 5,
  "verify": true,
  "note": "Agency tracking estimate, rounded to 0.1 degree; no precise crater or coordinate-frame tie confirmed in this research."
 },
 {
  "id": "m-lcross",
  "kind": "mission",
  "name": "LCROSS Centaur impact",
  "lat": -84.678,
  "lon": -48.6937,
  "short": "A rocket impact that revealed water ice",
  "detail": "NASA drove a spent rocket stage into the dark floor of Cabeus crater. The cloud it raised contained water ice.",
  "date": "9 Oct 2009",
  "source": {
   "name": "NASA LCROSS",
   "url": "https://science.nasa.gov/mission/lcross/"
  },
  "what": "impact",
  "operator": "NASA",
  "outcome": "success",
  "precisionKm": 0.01,
  "note": "The QuickMap object named LCROSS is the Centaur impact crater, identified with ShadowCam. It is distinct from the shepherding spacecraft impact; newer catalogue longitude -48.6937 differs slightly from the 2024 paper -48.6926."
 },
 {
  "id": "lcross-spacecraft",
  "kind": "mission",
  "name": "LCROSS spacecraft impact",
  "lat": -84.719,
  "lon": -49.61,
  "short": "The probe that flew through the water-rich dust cloud",
  "detail": "The LCROSS spacecraft measured the cloud raised by the Centaur stage, then hit the Moon about four minutes later. This pin is its estimated impact point.",
  "date": "9 Oct 2009",
  "source": {
   "name": "NASA LCROSS",
   "url": "https://science.nasa.gov/mission/lcross/"
  },
  "what": "impact",
  "operator": "NASA",
  "outcome": "success",
  "precisionKm": 1,
  "verify": true,
  "note": "Estimated spacecraft impact coordinate from NASA NSSDCA, not a confirmed crater in the supplied LROC list. Do not confuse it with the accurately mapped Centaur crater."
 },
 {
  "id": "grail-a-impact",
  "kind": "mission",
  "name": "GRAIL-A / Ebb impact",
  "lat": 75.6088,
  "lon": -26.594,
  "short": "One of two gravity-mapping probes' final impact sites",
  "detail": "Ebb helped map the Moon's gravity from orbit, then hit a mountain near the north pole as planned. Its small crater is one of the two GRAIL impact sites.",
  "date": "17 Dec 2012",
  "source": {
   "name": "NASA GRAIL",
   "url": "https://science.nasa.gov/mission/grail/"
  },
  "what": "impact",
  "operator": "NASA",
  "outcome": "success",
  "precisionKm": 0.0107
 },
 {
  "id": "grail-b-impact",
  "kind": "mission",
  "name": "GRAIL-B / Flow impact",
  "lat": 75.6508,
  "lon": -26.8341,
  "short": "One of two gravity-mapping probes' final impact sites",
  "detail": "Flow helped map the Moon's gravity from orbit, then hit a mountain near the north pole as planned. Its small crater is one of the two GRAIL impact sites.",
  "date": "17 Dec 2012",
  "source": {
   "name": "NASA GRAIL",
   "url": "https://science.nasa.gov/mission/grail/"
  },
  "what": "impact",
  "operator": "NASA",
  "outcome": "success",
  "precisionKm": 0.0122
 },
 {
  "id": "change-3",
  "kind": "active",
  "name": "Chang'e-3",
  "lat": 44.1214,
  "lon": -19.5117,
  "short": "China's first Moon lander, beside a wide crater in the Sea of Rains",
  "detail": "The lander delivered the Yutu rover to a plain made by ancient lava. Its telescope later watched the sky from the Moon.",
  "date": "14 Dec 2013",
  "source": {
   "name": "CNSA: China's lunar probe sets record for longest stay",
   "url": "https://www.cnsa.gov.cn/english/n6465652/n6465653/c6480404/content.html"
  },
  "what": "lander",
  "operator": "CNSA",
  "outcome": "success",
  "precisionKm": 0.01,
  "verify": true,
  "note": "Current operating status could not be confirmed for 2026-11-14. The cited CNSA operations report is from 2016; past is a conservative display fallback, not a claim that the lander has stopped. Yutu is a separate pin."
 },
 {
  "id": "yutu",
  "kind": "mission",
  "name": "Yutu",
  "lat": 44.1208,
  "lon": -19.5122,
  "short": "China's first Moon rover worked for 972 days",
  "detail": "Yutu drove near the Chang'e-3 lander before a fault stopped its wheels. It kept taking measurements until July 2016.",
  "date": "14 Dec 2013",
  "source": {
   "name": "CNSA: A delivery from the Moon (2022 retrospective)",
   "url": "https://www.cnsa.gov.cn/n6758823/n6758844/n6760445/n6760446/c6841528/content.html"
  },
  "what": "rover",
  "operator": "CNSA",
  "outcome": "success",
  "precisionKm": 0.0129,
  "note": "Pin is the rover position in the supplied QuickMap list, not its landing carrier. Date is landing aboard Chang'e-3, before rover deployment. CNSA confirms operations ended on 2016-07-31."
 },
 {
  "id": "ladee-impact",
  "kind": "mission",
  "name": "LADEE impact",
  "lat": 11.8493,
  "lon": -93.2493,
  "short": "A Moon atmosphere probe's final crater",
  "detail": "LADEE studied the Moon's thin atmosphere and dust from orbit. It ended its mission with a planned impact on the far side.",
  "date": "18 Apr 2014",
  "source": {
   "name": "NASA LADEE",
   "url": "https://science.nasa.gov/mission/ladee/"
  },
  "what": "impact",
  "operator": "NASA",
  "outcome": "success",
  "precisionKm": 0.01
 },
 {
  "id": "m-change4",
  "kind": "active",
  "name": "Chang'e-4 / Yutu-2",
  "lat": -45.4562,
  "lon": 177.5886,
  "short": "The first soft landing on the Moon's far side",
  "detail": "Chang'e-4 landed inside Von Kármán crater and released Yutu-2. A satellite relays their signals because the Moon blocks a direct view of Earth.",
  "date": "3 Jan 2019",
  "source": {
   "name": "CNSA: Chang'e and Yutu exploration retrospective (2025)",
   "url": "https://www.cnsa.gov.cn/n6758968/n6758973/c10666020/content.html"
  },
  "what": "lander",
  "operator": "CNSA",
  "outcome": "success",
  "precisionKm": 0.02,
  "verify": true,
  "note": "Pin is the fixed lander, not Yutu-2's current position. CNSA described continuing record-setting work on 2025-04-25, but operation on 2026-11-14 could not be confirmed. Past is a conservative display fallback, not a claim that the mission ended. QuickMap lists 177.5886 E; the 2020 LROC article gives 177.5885 E and 13 m uncertainty."
 },
 {
  "id": "beresheet",
  "kind": "mission",
  "name": "Beresheet",
  "lat": 32.5953,
  "lon": 19.3495,
  "short": "Israel's first Moon lander left a dark scar after its engine failed",
  "detail": "Beresheet crashed after its main engine failed during descent. LROC images reveal a dark scar and bright debris in the Sea of Serenity.",
  "date": "11 Apr 2019",
  "source": {
   "name": "LROC: Beresheet Crash Site Spotted",
   "url": "https://lroc.im-ldi.com/images/1101"
  },
  "what": "impact",
  "operator": "SpaceIL / Israel Aerospace Industries",
  "outcome": "failed",
  "precisionKm": 0.03,
  "note": "Uses supplied QuickMap terrain-registered point; the original article gives 32.5956 N, 19.3496 E, about 9 metres away. Precision is rounded conservatively above the published 20 by 8 metre confidence interval."
 },
 {
  "id": "longjiang-2-impact",
  "kind": "mission",
  "name": "Longjiang-2 impact",
  "lat": 16.6956,
  "lon": 159.517,
  "short": "A tiny lunar radio satellite's far-side crater",
  "detail": "Longjiang-2 tested radio astronomy technology in lunar orbit. A small new crater near Van Gent closely matches its predicted impact point.",
  "date": "31 Jul 2019",
  "source": {
   "name": "LROC: Longjiang-2 Impact Site Found",
   "url": "https://lroc.im-ldi.com/images/1132"
  },
  "what": "impact",
  "operator": "CNSA / Harbin Institute of Technology",
  "outcome": "success",
  "precisionKm": 0.01,
  "note": "LROC describes the crater attribution as very likely based on its position and size. Coordinates copied from supplied catalogue."
 },
 {
  "id": "chandrayaan-2-vikram",
  "kind": "mission",
  "name": "Chandrayaan-2 Vikram",
  "lat": -70.8811,
  "lon": 22.7834,
  "short": "India's first Moon lander broke apart during its landing attempt",
  "detail": "Vikram lost contact during descent and crashed in the southern highlands. A public search helped NASA locate the scattered pieces.",
  "date": "6 Sep 2019",
  "source": {
   "name": "LROC: Vikram Lander Found",
   "url": "https://lroc.im-ldi.com/images/1131"
  },
  "what": "impact",
  "operator": "ISRO",
  "outcome": "failed",
  "precisionKm": 0.01,
  "note": "UTC impact date is 2019-09-06; it was already September 7 in India. This pin is the impact site, not the still-operating Chandrayaan-2 orbiter."
 },
 {
  "id": "change-5",
  "kind": "mission",
  "name": "Chang'e-5",
  "lat": 43.0576,
  "lon": -51.9161,
  "short": "Brought Moon rocks to Earth for the first time since 1976",
  "detail": "The spacecraft drilled and scooped soil from a young lava plain in the Ocean of Storms. Its sample capsule returned 1,731 grams to Earth.",
  "date": "1 Dec 2020",
  "source": {
   "name": "CNSA: Chang'e-5 retrieves 1,731 grams of Moon samples",
   "url": "https://www.cnsa.gov.cn/english/n6465652/n6465653/c6810963/content.html"
  },
  "what": "sample-return",
  "operator": "CNSA",
  "outcome": "success",
  "precisionKm": 0.02,
  "note": "Pin is the lander that remained on the Moon, not the capsule that returned to Earth."
 },
 {
  "id": "change-5-t1-rocket-impact",
  "kind": "mission",
  "name": "Rocket-stage impact (2022)",
  "lat": 5.2269,
  "lon": -125.5152,
  "short": "A stray rocket stage made an unusual double crater",
  "detail": "A spent rocket stage struck the far side near Hertzsprung crater. The impact made two overlapping craters instead of one.",
  "date": "4 Mar 2022",
  "source": {
   "name": "LROC: Mystery Rocket Body Found",
   "url": "https://lroc.im-ldi.com/images/1261"
  },
  "what": "impact",
  "operator": "CNSA (catalogue attribution)",
  "outcome": "failed",
  "precisionKm": 0.01,
  "note": "The supplied LROC catalogue attributes the rocket to Chang'e-5-T1; the linked LROC image article calls it a mystery rocket. The crater location and date are confirmed. Outcome failed describes the unplanned surface collision, not the earlier launch mission."
 },
 {
  "id": "hakuto-r-mission-1",
  "kind": "mission",
  "name": "HAKUTO-R Mission 1",
  "lat": 47.58,
  "lon": 44.0938,
  "short": "Japan’s first private Moon lander crashed near Atlas crater",
  "detail": "The lander lost track of its height above the ground and crashed near Atlas crater. Images from lunar orbit show the impact mark and pieces of the spacecraft.",
  "date": "25 Apr 2023",
  "source": {
   "name": "ispace: Mission 1 landing analysis",
   "url": "https://www.ispace-inc.com/2023/05/26/ispace-announces-results-of-the-hakuto-r-mission-1-lunar-landing/"
  },
  "what": "impact",
  "operator": "ispace",
  "outcome": "failed",
  "precisionKm": 0.02,
  "note": "The company release uses 26 April in Japan; the lunar impact was 25 April in UTC. The Rashid rover carried by this lander never deployed."
 },
 {
  "id": "luna-25",
  "kind": "mission",
  "name": "Luna 25",
  "lat": -57.8651,
  "lon": 61.3588,
  "short": "A failed orbit change sent Russia's lander into a crater rim",
  "detail": "Luna 25 crashed before its planned landing near the south pole. LROC found a new crater on the steep inner rim of Pontécoulant G, about 400 kilometres from its intended site.",
  "date": "19 Aug 2023",
  "source": {
   "name": "NASA: LRO Observes Crater Likely from Luna 25 Impact",
   "url": "https://www.nasa.gov/humans-in-space/nasas-lro-observes-crater-likely-from-luna-25-impact/"
  },
  "what": "impact",
  "operator": "Roscosmos",
  "outcome": "failed",
  "precisionKm": 0.05,
  "verify": true,
  "note": "Crash and date are confirmed; NASA/LROC describe attribution of this new crater as likely rather than certain. The supplied QuickMap point refines the article's rounded 57.865 S, 61.360 E; 50 m uncertainty conservatively covers the original better-than-40 m location accuracy."
 },
 {
  "id": "m-chandrayaan3",
  "kind": "mission",
  "name": "Chandrayaan-3 / Pragyan",
  "lat": -69.374,
  "lon": 32.3187,
  "short": "India's first soft Moon landing sent a small rover across the soil",
  "detail": "The Vikram lander and Pragyan rover studied the southern highlands during one lunar day. The site is about 600 km from the south pole.",
  "date": "23 Aug 2023",
  "source": {
   "name": "ISRO: Chandrayaan-3 mission updates",
   "url": "https://www.isro.gov.in/Chandrayaan3.html"
  },
  "what": "lander",
  "operator": "ISRO",
  "outcome": "success",
  "precisionKm": 0.01,
  "note": "Pin is Vikram, not Pragyan's final parking spot. ISRO says both were put to sleep in September 2023 and later communication attempts continued; no confirmed resumed surface operations were found. Passive laser-reflector use does not mean powered surface operations."
 },
 {
  "id": "m-slim",
  "kind": "mission",
  "name": "SLIM",
  "lat": -13.316,
  "lon": 25.251,
  "short": "Japan landed close to its target and survived three cold lunar nights",
  "detail": "SLIM reached its target near Shioli crater, where two small robots explored nearby. JAXA ended surface operations in August 2024 after the lander survived three lunar nights.",
  "date": "19 Jan 2024",
  "source": {
   "name": "JAXA: Conclusion of Lunar Activities of SLIM",
   "url": "https://global.jaxa.jp/press/2024/08/20240826-1_e.html"
  },
  "what": "lander",
  "operator": "JAXA",
  "outcome": "success",
  "precisionKm": 0.02,
  "note": "Landing was 19 January at 15:20 UTC, or 20 January in Japan. The supplied QuickMap point is the lander, not the two nearby robots. JAXA reported extra success despite the unusual landing attitude."
 },
 {
  "id": "m-im1",
  "kind": "mission",
  "name": "IM-1 Odysseus",
  "lat": -80.1276,
  "lon": 1.4367,
  "short": "First US Moon landing since Apollo; the lander tipped over",
  "detail": "Odysseus landed near Malapert A and tipped onto its side, but sent back science data for about a week. The sloping ground shows why choosing a landing spot matters.",
  "date": "22 Feb 2024",
  "source": {
   "name": "NASA: first surface science via a commercial Moon mission",
   "url": "https://www.nasa.gov/missions/artemis/clps/nasa-collects-first-surface-science-in-decades-via-commercial-moon-mission/"
  },
  "what": "lander",
  "operator": "Intuitive Machines (NASA CLPS)",
  "outcome": "partial",
  "precisionKm": 0.02,
  "note": "Outcome is partial because the lander tipped over, despite returning data from NASA payloads. Surface operations ended on 29 February 2024; the company later confirmed that it did not revive."
 },
 {
  "id": "m-change6",
  "kind": "mission",
  "name": "Chang'e-6",
  "lat": -41.6383,
  "lon": -153.9857,
  "short": "The first mission to bring home rocks from the Moon's far side",
  "detail": "Chang'e-6 collected soil in the Apollo basin on the far side. It returned 1,935.3 grams to Earth for scientists to study.",
  "date": "1 Jun 2024",
  "source": {
   "name": "CNSA: Chang'e-6 collects 1,935.3 grams of far-side samples",
   "url": "https://www.cnsa.gov.cn/english/n6465652/n6465653/c10573149/content.html"
  },
  "what": "sample-return",
  "operator": "CNSA",
  "outcome": "success",
  "precisionKm": 0.03,
  "note": "UTC landing date is 2024-06-01 (22:23 UTC), although China's local date was June 2. Supplied QuickMap coordinates are the preferred later catalogue values; the initial LROC article gives -41.6385, -153.9852 with 30 m uncertainty."
 },
 {
  "id": "m-blueghost",
  "kind": "mission",
  "name": "Blue Ghost Mission 1",
  "lat": 18.5622,
  "lon": 61.8102,
  "short": "Worked for a full lunar day in Mare Crisium",
  "detail": "Blue Ghost landed upright in Mare Crisium and ran ten NASA experiments for about two weeks. It watched a solar eclipse and a lunar sunset before its mission ended.",
  "date": "2 Mar 2025",
  "source": {
   "name": "NASA: Blue Ghost Mission 1 concludes",
   "url": "https://www.nasa.gov/news-release/nasa-science-continues-after-fireflys-first-moon-mission-concludes/"
  },
  "what": "lander",
  "operator": "Firefly Aerospace (NASA CLPS)",
  "outcome": "success",
  "precisionKm": 0.02,
  "note": "Mission concluded 16 March 2025. A passive laser reflector can still be useful after powered operations end; that does not make the lander an active mission. The supplied QuickMap point differs from the rounded LROC article point by a few metres."
 },
 {
  "id": "m-im2",
  "kind": "mission",
  "name": "IM-2 Athena",
  "lat": -84.7906,
  "lon": 29.19567,
  "short": "Landed on its side in a south-pole crater and soon lost power",
  "detail": "Athena reached Mons Mouton but came to rest on its side inside a small crater. It returned some data before its batteries ran out, showing how shade and rough ground can end a mission.",
  "date": "6 Mar 2025",
  "source": {
   "name": "NASA: IM-2 mission ends after returning some data",
   "url": "https://www.nasa.gov/news-release/nasa-receives-some-data-before-intuitive-machines-ends-lunar-mission/"
  },
  "what": "lander",
  "operator": "Intuitive Machines (NASA CLPS)",
  "outcome": "partial",
  "precisionKm": 0.02,
  "note": "Mission ended 7 March 2025. The point is the measured resting place, not the announced landing target; the existing app latitude -84.81 is about 0.59 km farther south."
 },
 {
  "id": "hakuto-r-mission-2",
  "kind": "mission",
  "name": "HAKUTO-R Mission 2 / RESILIENCE",
  "lat": 60.4445,
  "lon": -4.588,
  "short": "RESILIENCE crashed in Mare Frigoris before its rover could deploy",
  "detail": "RESILIENCE could not slow down enough and struck Mare Frigoris. Orbital images show a dark impact mark where the lander and its small rover were lost.",
  "date": "5 Jun 2025",
  "source": {
   "name": "ispace: Mission 2 status and mission end",
   "url": "https://www.ispace-inc.com/2025/06/06/status-update-on-ispace-mission-2-smbc-x-hakuto-r-venture-moon/"
  },
  "what": "impact",
  "operator": "ispace",
  "outcome": "failed",
  "precisionKm": 0.02,
  "note": "The company release uses 6 June in Japan; the lunar impact was 5 June in UTC. The TENACIOUS rover remained aboard and did not begin a separate surface mission."
 },
 {
  "id": "falcon-9-upper-stage-2026",
  "kind": "mission",
  "name": "Falcon 9 upper-stage impact (2026)",
  "lat": 19.4759,
  "lon": -93.2862,
  "short": "A spent rocket stage made a fresh 18-metre crater on the far side",
  "detail": "A spent Falcon 9 upper stage hit the Moon at 06:35 UTC on 5 August 2026. LROC found an 18-metre crater with bright and dark streaks of thrown-out soil.",
  "date": "5 Aug 2026",
  "source": {
   "name": "LROC: Falcon 9 Impact, 18 August 2026",
   "url": "https://www.lroc.im-ldi.com/images/1499"
  },
  "what": "impact",
  "operator": "SpaceX",
  "outcome": "failed",
  "precisionKm": 0.1,
  "note": "Uses the LROC article's refined 19.4759 N, 266.7138 E, converted to -93.2862 east-positive longitude. Supplied QuickMap has 19.473 N, -93.286 E, about 88 m away; 0.1 km is conservative because the article gives no formal uncertainty. Outcome failed describes the unplanned surface collision, not the landers launched by this stage."
 },
 {
  "id": "griffin-mission-1",
  "kind": "planned",
  "name": "Griffin Mission 1 / FLIP",
  "lat": -85.42658,
  "lon": 31.74276,
  "short": "A large lander will bring rovers to the Nobile region",
  "detail": "Griffin-1 is planned to carry Astrolab's FLIP rover and smaller rovers to the south polar region. It will test driving systems for later vehicles that can carry astronauts.",
  "date": "2026",
  "source": {
   "name": "NASA launch schedule: Moon Base Voyager Griffin-1",
   "url": "https://www.nasa.gov/event/clps-flight-astrobotics-griffin-mission-one/"
  },
  "what": "lander",
  "operator": "Astrobotic / Voyager Technologies (NASA CLPS)",
  "outcome": "planned",
  "precisionKm": 40,
  "verify": true,
  "note": "Still upcoming as of 14 November 2026; NASA says late 2026 launch. NASA and Astrobotic name the Nobile region; this marker is the Mons Mouton area west of Nobile identified on NASA's April 2026 delivery-site diagram, not a final touchdown coordinate. VIPER now flies on a separate Blue Origin mission. Coordinate-region association remains approximate. Verify: the final lander coordinates were not confirmed; the west-Nobile/Mons Mouton association comes from a broad NASA planning map and should be checked before detailed terrain comparisons."
 },
 {
  "id": "blue-ghost-mission-2",
  "kind": "planned",
  "name": "Blue Ghost Mission 2",
  "lat": -24.91,
  "lon": 177.34,
  "short": "A planned far-side lander will listen for signals from the early universe",
  "detail": "Blue Ghost 2 is planned for Nassau crater on the far side. Its radio telescope can listen there with the Moon blocking much of Earth's radio noise.",
  "date": "2027",
  "source": {
   "name": "Firefly: Blue Ghost + Elytra, Lunar Far Side",
   "url": "https://fireflyspace.com/missions/blue-ghost-mission-2/"
  },
  "what": "lander",
  "operator": "Firefly Aerospace (NASA CLPS)",
  "outcome": "planned",
  "precisionKm": 40,
  "note": "No earlier than 2027 launch. Nassau crater centre, rounded by USGS to 0.01 degrees, is used as a regional marker; not a published touchdown point. A 40 km allowance is about the crater radius. Elytra and Lunar Pathfinder remain in orbit and are not additional surface sites."
 },
 {
  "id": "blue-moon-mk1-endurance",
  "kind": "planned",
  "name": "Blue Moon MK1 Endurance",
  "lat": -89.46316,
  "lon": -137.48955,
  "short": "A large lander will test landing on the ridge near Shackleton",
  "detail": "Endurance will try to land on Shackleton Connecting Ridge. Cameras will watch how its engine blasts dust from the ground during landing.",
  "date": "2027",
  "source": {
   "name": "NASA launch schedule: Moon Base Blue Origin Blue Moon Mark1",
   "url": "https://www.nasa.gov/event/clps-flight-blue-origins-blue-moon-mark-1/"
  },
  "what": "lander",
  "operator": "Blue Origin (NASA CLPS)",
  "outcome": "planned",
  "precisionKm": 15,
  "note": "NASA's current event page gives 2027, superseding older 2025 and 2026 dates. Centre of the supplied Connecting Ridge polygon only; no final lander touchdown coordinate is published. This first MK 1 mission is separate from the second MK 1 that will deliver VIPER."
 },
 {
  "id": "blue-moon-mk1-viper",
  "kind": "planned",
  "name": "Blue Moon MK1 / VIPER delivery",
  "lat": -85.42088,
  "lon": 31.6218,
  "short": "The lander chosen to carry VIPER to the south polar region",
  "detail": "Blue Origin's second MK 1 lander is planned to carry and unload NASA's VIPER rover. This is the same arrival as the VIPER pin.",
  "date": "2027",
  "source": {
   "name": "NASA selects Blue Origin to deliver VIPER (19 September 2025; reconfirmed October 2026)",
   "url": "https://www.nasa.gov/news-release/nasa-selects-blue-origin-to-deliver-viper-rover-to-moons-south-pole/"
  },
  "what": "lander",
  "operator": "Blue Origin (NASA CLPS)",
  "outcome": "planned",
  "precisionKm": 10,
  "note": "Late 2027 target. Co-located with VIPER because no separate lander touchdown point is published. Mission-area centre only; do not count these two pins as two separate landings. NASA initially made delivery conditional on exercising a contract option."
 },
 {
  "id": "im-3",
  "kind": "planned",
  "name": "IM-3 Trinity",
  "lat": 7.585,
  "lon": -58.725,
  "short": "A lander and small rovers will visit the bright Reiner Gamma swirl",
  "detail": "IM-3 will study a bright swirl of soil with an unusual magnetic field. Small rovers will help test how robots can explore together.",
  "date": "2027",
  "source": {
   "name": "NASA current launch schedule: Moon Base Intuitive Machines IM-3",
   "url": "https://www.nasa.gov/event/clps-flight-intuitive-machines-im-3/"
  },
  "what": "lander",
  "operator": "Intuitive Machines (NASA CLPS)",
  "outcome": "planned",
  "precisionKm": 5,
  "note": "NASA lists early 2027. The operator's 12 November 2026 release narrows the launch target to March-April 2027; this is not a fixed landing date. The coordinate is the published Lunar Vertex science landing target, not an as-flown position. Five km is a conservative planning allowance, not a published landing ellipse. The named Reiner Gamma target is also present in the supplied QuickMap Constellation list."
 },
 {
  "id": "im-4",
  "kind": "planned",
  "name": "IM-4",
  "lat": -85.42658,
  "lon": 31.74276,
  "short": "A planned lander will study soil and the environment at Mons Mouton",
  "detail": "IM-4 is planned for Mons Mouton near the south pole. Its instruments will study the ground and conditions future explorers will face.",
  "date": "2027",
  "source": {
   "name": "NASA launch schedule: Moon Base Intuitive Machines IM-4; updated 21 October 2026",
   "url": "https://www.nasa.gov/event/clps-flight-intuitive-machines-im-4-2/"
  },
  "what": "lander",
  "operator": "Intuitive Machines (NASA CLPS)",
  "outcome": "planned",
  "precisionKm": 25,
  "note": "NASA current page gives 2027 and Mons Mouton. Marker is the candidate-region centre; no final spacecraft landing point is published."
 },
 {
  "id": "viper",
  "kind": "planned",
  "name": "VIPER",
  "lat": -85.42088,
  "lon": 31.6218,
  "short": "A rover that will drill into cold ground to look for water ice",
  "detail": "VIPER will explore sunlit ground and nearby deep shadows near the south pole. Its drill will test where water ice is hidden below the surface.",
  "date": "2027",
  "source": {
   "name": "NASA selects Blue Origin to deliver VIPER (19 September 2025; reconfirmed October 2026)",
   "url": "https://www.nasa.gov/news-release/nasa-selects-blue-origin-to-deliver-viper-rover-to-moons-south-pole/"
  },
  "what": "rover",
  "operator": "NASA",
  "outcome": "planned",
  "precisionKm": 10,
  "note": "Late 2027 delivery by Blue Origin's second Blue Moon MK 1. Point is the published Mons Mouton science-area centre, not a final landing point; 10 km is a conservative planning allowance. The current contract uses a delivery option. The same landing is also represented by blue-moon-mk1-viper."
 },
 {
  "id": "blue-ghost-mission-3",
  "kind": "planned",
  "name": "Blue Ghost Mission 3",
  "lat": 36.03,
  "lon": -40.14,
  "short": "A lander and rover will explore unusual volcanic domes",
  "detail": "Blue Ghost 3 will explore the Gruithuisen Domes, including Gamma Dome. Their unusual rocks may explain a kind of volcanism rarely seen on the Moon.",
  "date": "2028",
  "source": {
   "name": "Firefly: Blue Ghost + Elytra, Gruithuisen Domes",
   "url": "https://fireflyspace.com/missions/blue-ghost-elytra-gruithuisen-domes/"
  },
  "what": "lander",
  "operator": "Firefly Aerospace (NASA CLPS)",
  "outcome": "planned",
  "precisionKm": 40,
  "note": "No earlier than 2028 launch. Point is QuickMap's broad Constellation Gruithuisen region centre, not the final lander target;40 km allows for the extent of the domes and nearby landing terrain."
 },
 {
  "id": "chandrayaan-5-lupex",
  "kind": "planned",
  "name": "Chandrayaan-5 / LUPEX",
  "lat": -89.46316,
  "lon": -137.48955,
  "short": "India and Japan plan to drill for water near the south pole",
  "detail": "India will provide a lander and Japan a rover and rocket. The rover will collect soil near deep shadows to measure how much water it contains.",
  "date": "2028",
  "source": {
   "name": "JAXA LUPEX mission site, published 6 November 2026",
   "url": "https://humans-in-space.jaxa.jp/future/lupex/"
  },
  "what": "rover",
  "operator": "ISRO / JAXA",
  "outcome": "planned",
  "precisionKm": 25,
  "note": "JAXA gives FY 2028 launch (April 2028-March 2029); 2028 is the start of that window, not a guaranteed landing year. Connecting Ridge 1 is a studied candidate, not a final selected landing point: ISRO Space Research 2022-2023, page 117, says it is most suitable among three candidates. The coordinate is a centre of QuickMap's broader Connecting Ridge region, not a CR 1 landing ellipse. See planned-notes.md for the study source."
 },
 {
  "id": "blue-ghost-mission-4",
  "kind": "planned",
  "name": "Blue Ghost Mission 4",
  "lat": -86.76394,
  "lon": -22.77702,
  "short": "Two rovers will look for useful materials near Haworth crater",
  "detail": "Blue Ghost 4 is planned to land just outside Haworth crater near the south pole. Rovers will be able to visit nearby dark areas while the lander stays in sunlight.",
  "date": "2029",
  "source": {
   "name": "Firefly: Blue Ghost + Elytra, Lunar South Pole",
   "url": "https://fireflyspace.com/missions/blue-ghost-elytra-lunar-south-pole/"
  },
  "what": "lander",
  "operator": "Firefly Aerospace (NASA CLPS)",
  "outcome": "planned",
  "precisionKm": 50,
  "note": "No earlier than 2029 launch. Firefly specifies Haworth rim, about 40 km south of Mons Malapert. Marker is QuickMap's broad Haworth candidate-region centre, not a final landing point;50 km deliberately covers a wider rim region."
 },
 {
  "id": "change-8",
  "kind": "planned",
  "name": "Chang'e-8",
  "lat": -85.42658,
  "lon": 31.74276,
  "short": "A planned test of how future Moon bases could use local materials",
  "detail": "Chang'e-8 is planned for the Leibnitz-Beta Plateau near the south pole. It will test ways to use local resources and work with international instruments and robots.",
  "date": "2029",
  "source": {
   "name": "CNSA: Chang'e-8 around 2029 and Leibnitz-Beta Plateau target (25 April 2025)",
   "url": "https://www.cnsa.gov.cn/english/n6465652/n6465653/c10670293/content.html"
  },
  "what": "lander",
  "operator": "CNSA",
  "outcome": "planned",
  "precisionKm": 25,
  "note": "Around 2029 is a launch target, not a fixed landing date. The point represents the named Leibnitz Beta Plateau polygon in the older QuickMap Artemis layer, not a published spacecraft touchdown point."
 },
 {
  "id": "ice-ice-cabeus",
  "kind": "ice",
  "name": "Cabeus",
  "lat": -84.678,
  "lon": -48.6937,
  "short": "Water measured in the LCROSS impact plume at one spot",
  "detail": "LCROSS measured water in debris blasted from one impact site in Cabeus; this does not confirm ice across the crater. M3 reported signs of surface ice in small permanently shaded patches inside this crater.",
  "source": {
   "name": "Colaprete, A., et al. (2010). Detection of water in the LCROSS ejecta plume. Science 330, 463-468. doi:10.1126/science.1186986.",
   "url": "https://doi.org/10.1126/science.1186986"
  },
  "ice": "confirmed",
  "evidence": [
   {
    "instrument": "LCROSS near-infrared and ultraviolet spectrometers",
    "finding": "LCROSS measured water in debris blasted from one impact site in Cabeus; this does not confirm ice across the crater.",
    "citation": "Colaprete, A., et al. (2010). Detection of water in the LCROSS ejecta plume. Science 330, 463-468. doi:10.1126/science.1186986.",
    "url": "https://doi.org/10.1126/science.1186986"
   },
   {
    "instrument": "Chandrayaan-1 Moon Mineralogy Mapper (M3)",
    "finding": "M3 reported signs of surface ice in small permanently shaded patches inside this crater.",
    "citation": "Li, S., Lucey, P.G., Milliken, R.E., Hayne, P.O., Fisher, E., Williams, J.-P., Hurley, D.M., Elphic, R.C. (2018). Direct evidence of surface exposed water ice in the lunar polar regions. PNAS 115, 8907-8912. doi:10.1073/pnas.1802345115. Lemelin, M., Li, S., Mazarico, E., Siegler, M.A., Kring, D.A., Paige, D.A. (2021). Framework for Coordinated Efforts in the Exploration of Volatiles in the South Polar Region of the Moon. The Planetary Science Journal 2, 103. doi:10.3847/PSJ/abf3c5. Data: doi:10.5281/zenodo.4646092.",
    "url": "https://zenodo.org/records/4646092"
   }
  ],
  "diameterKm": 100.58
 },
 {
  "id": "ice-ice-shackleton",
  "kind": "ice",
  "name": "Shackleton",
  "lat": -89.67,
  "lon": 129.78,
  "short": "M3 reported signs of surface ice in small patches here",
  "detail": "M3 reported signs of surface ice in small permanently shaded patches inside this crater.",
  "source": {
   "name": "Li, S., Lucey, P.G., Milliken, R.E., Hayne, P.O., Fisher, E., Williams, J.-P., Hurley, D.M., Elphic, R.C. (2018). Direct evidence of surface exposed water ice in the lunar polar regions. PNAS 115, 8907-8912. doi:10.1073/pnas.1802345115. Lemelin, M., Li, S., Mazarico, E., Siegler, M.A., Kring, D.A., Paige, D.A. (2021). Framework for Coordinated Efforts in the Exploration of Volatiles in the South Polar Region of the Moon. The Planetary Science Journal 2, 103. doi:10.3847/PSJ/abf3c5. Data: doi:10.5281/zenodo.4646092.",
   "url": "https://zenodo.org/records/4646092"
  },
  "ice": "detected",
  "evidence": [
   {
    "instrument": "Chandrayaan-1 Moon Mineralogy Mapper (M3)",
    "finding": "M3 reported signs of surface ice in small permanently shaded patches inside this crater.",
    "citation": "Li, S., Lucey, P.G., Milliken, R.E., Hayne, P.O., Fisher, E., Williams, J.-P., Hurley, D.M., Elphic, R.C. (2018). Direct evidence of surface exposed water ice in the lunar polar regions. PNAS 115, 8907-8912. doi:10.1073/pnas.1802345115. Lemelin, M., Li, S., Mazarico, E., Siegler, M.A., Kring, D.A., Paige, D.A. (2021). Framework for Coordinated Efforts in the Exploration of Volatiles in the South Polar Region of the Moon. The Planetary Science Journal 2, 103. doi:10.3847/PSJ/abf3c5. Data: doi:10.5281/zenodo.4646092.",
    "url": "https://zenodo.org/records/4646092"
   }
  ],
  "diameterKm": 20.92
 },
 {
  "id": "ice-ice-haworth",
  "kind": "ice",
  "name": "Haworth",
  "lat": -87.45,
  "lon": -5.17,
  "short": "M3 reported signs of surface ice in small patches here",
  "detail": "M3 reported signs of surface ice in small permanently shaded patches inside this crater.",
  "source": {
   "name": "Li, S., Lucey, P.G., Milliken, R.E., Hayne, P.O., Fisher, E., Williams, J.-P., Hurley, D.M., Elphic, R.C. (2018). Direct evidence of surface exposed water ice in the lunar polar regions. PNAS 115, 8907-8912. doi:10.1073/pnas.1802345115. Lemelin, M., Li, S., Mazarico, E., Siegler, M.A., Kring, D.A., Paige, D.A. (2021). Framework for Coordinated Efforts in the Exploration of Volatiles in the South Polar Region of the Moon. The Planetary Science Journal 2, 103. doi:10.3847/PSJ/abf3c5. Data: doi:10.5281/zenodo.4646092.",
   "url": "https://zenodo.org/records/4646092"
  },
  "ice": "detected",
  "evidence": [
   {
    "instrument": "Chandrayaan-1 Moon Mineralogy Mapper (M3)",
    "finding": "M3 reported signs of surface ice in small permanently shaded patches inside this crater.",
    "citation": "Li, S., Lucey, P.G., Milliken, R.E., Hayne, P.O., Fisher, E., Williams, J.-P., Hurley, D.M., Elphic, R.C. (2018). Direct evidence of surface exposed water ice in the lunar polar regions. PNAS 115, 8907-8912. doi:10.1073/pnas.1802345115. Lemelin, M., Li, S., Mazarico, E., Siegler, M.A., Kring, D.A., Paige, D.A. (2021). Framework for Coordinated Efforts in the Exploration of Volatiles in the South Polar Region of the Moon. The Planetary Science Journal 2, 103. doi:10.3847/PSJ/abf3c5. Data: doi:10.5281/zenodo.4646092.",
    "url": "https://zenodo.org/records/4646092"
   }
  ],
  "diameterKm": 51.42
 },
 {
  "id": "ice-ice-shoemaker",
  "kind": "ice",
  "name": "Shoemaker",
  "lat": -88.137,
  "lon": 45.911,
  "short": "M3 reported signs of surface ice in small patches here",
  "detail": "M3 reported signs of surface ice in small permanently shaded patches inside this crater.",
  "source": {
   "name": "Li, S., Lucey, P.G., Milliken, R.E., Hayne, P.O., Fisher, E., Williams, J.-P., Hurley, D.M., Elphic, R.C. (2018). Direct evidence of surface exposed water ice in the lunar polar regions. PNAS 115, 8907-8912. doi:10.1073/pnas.1802345115. Lemelin, M., Li, S., Mazarico, E., Siegler, M.A., Kring, D.A., Paige, D.A. (2021). Framework for Coordinated Efforts in the Exploration of Volatiles in the South Polar Region of the Moon. The Planetary Science Journal 2, 103. doi:10.3847/PSJ/abf3c5. Data: doi:10.5281/zenodo.4646092.",
   "url": "https://zenodo.org/records/4646092"
  },
  "ice": "detected",
  "evidence": [
   {
    "instrument": "Chandrayaan-1 Moon Mineralogy Mapper (M3)",
    "finding": "M3 reported signs of surface ice in small permanently shaded patches inside this crater.",
    "citation": "Li, S., Lucey, P.G., Milliken, R.E., Hayne, P.O., Fisher, E., Williams, J.-P., Hurley, D.M., Elphic, R.C. (2018). Direct evidence of surface exposed water ice in the lunar polar regions. PNAS 115, 8907-8912. doi:10.1073/pnas.1802345115. Lemelin, M., Li, S., Mazarico, E., Siegler, M.A., Kring, D.A., Paige, D.A. (2021). Framework for Coordinated Efforts in the Exploration of Volatiles in the South Polar Region of the Moon. The Planetary Science Journal 2, 103. doi:10.3847/PSJ/abf3c5. Data: doi:10.5281/zenodo.4646092.",
    "url": "https://zenodo.org/records/4646092"
   }
  ],
  "diameterKm": 51.82
 },
 {
  "id": "ice-ice-faustini",
  "kind": "ice",
  "name": "Faustini",
  "lat": -87.1832,
  "lon": 84.3099,
  "short": "M3 reported signs of surface ice in small patches here",
  "detail": "M3 reported signs of surface ice in small permanently shaded patches inside this crater.",
  "source": {
   "name": "Li, S., Lucey, P.G., Milliken, R.E., Hayne, P.O., Fisher, E., Williams, J.-P., Hurley, D.M., Elphic, R.C. (2018). Direct evidence of surface exposed water ice in the lunar polar regions. PNAS 115, 8907-8912. doi:10.1073/pnas.1802345115. Lemelin, M., Li, S., Mazarico, E., Siegler, M.A., Kring, D.A., Paige, D.A. (2021). Framework for Coordinated Efforts in the Exploration of Volatiles in the South Polar Region of the Moon. The Planetary Science Journal 2, 103. doi:10.3847/PSJ/abf3c5. Data: doi:10.5281/zenodo.4646092.",
   "url": "https://zenodo.org/records/4646092"
  },
  "ice": "detected",
  "evidence": [
   {
    "instrument": "Chandrayaan-1 Moon Mineralogy Mapper (M3)",
    "finding": "M3 reported signs of surface ice in small permanently shaded patches inside this crater.",
    "citation": "Li, S., Lucey, P.G., Milliken, R.E., Hayne, P.O., Fisher, E., Williams, J.-P., Hurley, D.M., Elphic, R.C. (2018). Direct evidence of surface exposed water ice in the lunar polar regions. PNAS 115, 8907-8912. doi:10.1073/pnas.1802345115. Lemelin, M., Li, S., Mazarico, E., Siegler, M.A., Kring, D.A., Paige, D.A. (2021). Framework for Coordinated Efforts in the Exploration of Volatiles in the South Polar Region of the Moon. The Planetary Science Journal 2, 103. doi:10.3847/PSJ/abf3c5. Data: doi:10.5281/zenodo.4646092.",
    "url": "https://zenodo.org/records/4646092"
   }
  ],
  "diameterKm": 42.48
 },
 {
  "id": "ice-ice-nobile",
  "kind": "ice",
  "name": "Nobile",
  "lat": -85.2752,
  "lon": 53.2725,
  "short": "M3 reported signs of surface ice in small patches here",
  "detail": "M3 reported signs of surface ice in small permanently shaded patches inside this crater.",
  "source": {
   "name": "Li, S., Lucey, P.G., Milliken, R.E., Hayne, P.O., Fisher, E., Williams, J.-P., Hurley, D.M., Elphic, R.C. (2018). Direct evidence of surface exposed water ice in the lunar polar regions. PNAS 115, 8907-8912. doi:10.1073/pnas.1802345115. Lemelin, M., Li, S., Mazarico, E., Siegler, M.A., Kring, D.A., Paige, D.A. (2021). Framework for Coordinated Efforts in the Exploration of Volatiles in the South Polar Region of the Moon. The Planetary Science Journal 2, 103. doi:10.3847/PSJ/abf3c5. Data: doi:10.5281/zenodo.4646092.",
   "url": "https://zenodo.org/records/4646092"
  },
  "ice": "detected",
  "evidence": [
   {
    "instrument": "Chandrayaan-1 Moon Mineralogy Mapper (M3)",
    "finding": "M3 reported signs of surface ice in small permanently shaded patches inside this crater.",
    "citation": "Li, S., Lucey, P.G., Milliken, R.E., Hayne, P.O., Fisher, E., Williams, J.-P., Hurley, D.M., Elphic, R.C. (2018). Direct evidence of surface exposed water ice in the lunar polar regions. PNAS 115, 8907-8912. doi:10.1073/pnas.1802345115. Lemelin, M., Li, S., Mazarico, E., Siegler, M.A., Kring, D.A., Paige, D.A. (2021). Framework for Coordinated Efforts in the Exploration of Volatiles in the South Polar Region of the Moon. The Planetary Science Journal 2, 103. doi:10.3847/PSJ/abf3c5. Data: doi:10.5281/zenodo.4646092.",
    "url": "https://zenodo.org/records/4646092"
   }
  ],
  "diameterKm": 79.27
 },
 {
  "id": "ice-ice-de-gerlache",
  "kind": "ice",
  "name": "de Gerlache",
  "lat": -88.4849,
  "lon": -88.3447,
  "short": "M3 reported signs of surface ice in small patches here",
  "detail": "M3 reported signs of surface ice in small permanently shaded patches inside this crater.",
  "source": {
   "name": "Li, S., Lucey, P.G., Milliken, R.E., Hayne, P.O., Fisher, E., Williams, J.-P., Hurley, D.M., Elphic, R.C. (2018). Direct evidence of surface exposed water ice in the lunar polar regions. PNAS 115, 8907-8912. doi:10.1073/pnas.1802345115. Lemelin, M., Li, S., Mazarico, E., Siegler, M.A., Kring, D.A., Paige, D.A. (2021). Framework for Coordinated Efforts in the Exploration of Volatiles in the South Polar Region of the Moon. The Planetary Science Journal 2, 103. doi:10.3847/PSJ/abf3c5. Data: doi:10.5281/zenodo.4646092.",
   "url": "https://zenodo.org/records/4646092"
  },
  "ice": "detected",
  "evidence": [
   {
    "instrument": "Chandrayaan-1 Moon Mineralogy Mapper (M3)",
    "finding": "M3 reported signs of surface ice in small permanently shaded patches inside this crater.",
    "citation": "Li, S., Lucey, P.G., Milliken, R.E., Hayne, P.O., Fisher, E., Williams, J.-P., Hurley, D.M., Elphic, R.C. (2018). Direct evidence of surface exposed water ice in the lunar polar regions. PNAS 115, 8907-8912. doi:10.1073/pnas.1802345115. Lemelin, M., Li, S., Mazarico, E., Siegler, M.A., Kring, D.A., Paige, D.A. (2021). Framework for Coordinated Efforts in the Exploration of Volatiles in the South Polar Region of the Moon. The Planetary Science Journal 2, 103. doi:10.3847/PSJ/abf3c5. Data: doi:10.5281/zenodo.4646092.",
    "url": "https://zenodo.org/records/4646092"
   }
  ],
  "diameterKm": 32.71
 },
 {
  "id": "ice-ice-scott",
  "kind": "ice",
  "name": "Scott",
  "lat": -82.3532,
  "lon": 48.5154,
  "short": "M3 reported signs of surface ice in small patches here",
  "detail": "M3 reported signs of surface ice in small permanently shaded patches inside this crater.",
  "source": {
   "name": "Li, S., Lucey, P.G., Milliken, R.E., Hayne, P.O., Fisher, E., Williams, J.-P., Hurley, D.M., Elphic, R.C. (2018). Direct evidence of surface exposed water ice in the lunar polar regions. PNAS 115, 8907-8912. doi:10.1073/pnas.1802345115. Lemelin, M., Li, S., Mazarico, E., Siegler, M.A., Kring, D.A., Paige, D.A. (2021). Framework for Coordinated Efforts in the Exploration of Volatiles in the South Polar Region of the Moon. The Planetary Science Journal 2, 103. doi:10.3847/PSJ/abf3c5. Data: doi:10.5281/zenodo.4646092.",
   "url": "https://zenodo.org/records/4646092"
  },
  "ice": "detected",
  "evidence": [
   {
    "instrument": "Chandrayaan-1 Moon Mineralogy Mapper (M3)",
    "finding": "M3 reported signs of surface ice in small permanently shaded patches inside this crater.",
    "citation": "Li, S., Lucey, P.G., Milliken, R.E., Hayne, P.O., Fisher, E., Williams, J.-P., Hurley, D.M., Elphic, R.C. (2018). Direct evidence of surface exposed water ice in the lunar polar regions. PNAS 115, 8907-8912. doi:10.1073/pnas.1802345115. Lemelin, M., Li, S., Mazarico, E., Siegler, M.A., Kring, D.A., Paige, D.A. (2021). Framework for Coordinated Efforts in the Exploration of Volatiles in the South Polar Region of the Moon. The Planetary Science Journal 2, 103. doi:10.3847/PSJ/abf3c5. Data: doi:10.5281/zenodo.4646092.",
    "url": "https://zenodo.org/records/4646092"
   }
  ],
  "diameterKm": 107.82
 },
 {
  "id": "ice-ice-kuhn",
  "kind": "ice",
  "name": "Kuhn",
  "lat": -84.482,
  "lon": -152.4779,
  "short": "M3 reported signs of surface ice in small patches here",
  "detail": "M3 reported signs of surface ice in small permanently shaded patches inside this crater.",
  "source": {
   "name": "Li, S., Lucey, P.G., Milliken, R.E., Hayne, P.O., Fisher, E., Williams, J.-P., Hurley, D.M., Elphic, R.C. (2018). Direct evidence of surface exposed water ice in the lunar polar regions. PNAS 115, 8907-8912. doi:10.1073/pnas.1802345115. Lemelin, M., Li, S., Mazarico, E., Siegler, M.A., Kring, D.A., Paige, D.A. (2021). Framework for Coordinated Efforts in the Exploration of Volatiles in the South Polar Region of the Moon. The Planetary Science Journal 2, 103. doi:10.3847/PSJ/abf3c5. Data: doi:10.5281/zenodo.4646092.",
   "url": "https://zenodo.org/records/4646092"
  },
  "ice": "detected",
  "evidence": [
   {
    "instrument": "Chandrayaan-1 Moon Mineralogy Mapper (M3)",
    "finding": "M3 reported signs of surface ice in small permanently shaded patches inside this crater.",
    "citation": "Li, S., Lucey, P.G., Milliken, R.E., Hayne, P.O., Fisher, E., Williams, J.-P., Hurley, D.M., Elphic, R.C. (2018). Direct evidence of surface exposed water ice in the lunar polar regions. PNAS 115, 8907-8912. doi:10.1073/pnas.1802345115. Lemelin, M., Li, S., Mazarico, E., Siegler, M.A., Kring, D.A., Paige, D.A. (2021). Framework for Coordinated Efforts in the Exploration of Volatiles in the South Polar Region of the Moon. The Planetary Science Journal 2, 103. doi:10.3847/PSJ/abf3c5. Data: doi:10.5281/zenodo.4646092.",
    "url": "https://zenodo.org/records/4646092"
   }
  ],
  "diameterKm": 16.61
 },
 {
  "id": "ice-ice-malapert-c",
  "kind": "ice",
  "name": "Malapert C",
  "lat": -80.9816,
  "lon": 10.0832,
  "short": "M3 reported signs of surface ice in small patches here",
  "detail": "M3 reported signs of surface ice in small permanently shaded patches inside this crater.",
  "source": {
   "name": "Li, S., Lucey, P.G., Milliken, R.E., Hayne, P.O., Fisher, E., Williams, J.-P., Hurley, D.M., Elphic, R.C. (2018). Direct evidence of surface exposed water ice in the lunar polar regions. PNAS 115, 8907-8912. doi:10.1073/pnas.1802345115. Lemelin, M., Li, S., Mazarico, E., Siegler, M.A., Kring, D.A., Paige, D.A. (2021). Framework for Coordinated Efforts in the Exploration of Volatiles in the South Polar Region of the Moon. The Planetary Science Journal 2, 103. doi:10.3847/PSJ/abf3c5. Data: doi:10.5281/zenodo.4646092.",
   "url": "https://zenodo.org/records/4646092"
  },
  "ice": "detected",
  "evidence": [
   {
    "instrument": "Chandrayaan-1 Moon Mineralogy Mapper (M3)",
    "finding": "M3 reported signs of surface ice in small permanently shaded patches inside this crater.",
    "citation": "Li, S., Lucey, P.G., Milliken, R.E., Hayne, P.O., Fisher, E., Williams, J.-P., Hurley, D.M., Elphic, R.C. (2018). Direct evidence of surface exposed water ice in the lunar polar regions. PNAS 115, 8907-8912. doi:10.1073/pnas.1802345115. Lemelin, M., Li, S., Mazarico, E., Siegler, M.A., Kring, D.A., Paige, D.A. (2021). Framework for Coordinated Efforts in the Exploration of Volatiles in the South Polar Region of the Moon. The Planetary Science Journal 2, 103. doi:10.3847/PSJ/abf3c5. Data: doi:10.5281/zenodo.4646092.",
    "url": "https://zenodo.org/records/4646092"
   }
  ],
  "diameterKm": 38.99
 },
 {
  "id": "ice-ice-amundsen",
  "kind": "ice",
  "name": "Amundsen",
  "lat": -84.4398,
  "lon": 83.0691,
  "short": "Cold traps are predicted here; no detection is mapped here",
  "detail": "Temperature and shadow maps predict cold traps here, but the reviewed map of reported ice signals has no detection assigned to this crater.",
  "source": {
   "name": "Paige, D.A., et al. (2010). Diviner Lunar Radiometer observations of cold traps in the Moon's south polar region. Science 330, 479-482. doi:10.1126/science.1187726. Dataset: Paige et al. (2018), LRO DLRE Level 5 PRP V2.0, NASA PDS, LRO-L-DLRE-5-PRP-V2.0. Barker, M.K., Mazarico, E., Neumann, G.A., Smith, D.E., Zuber, M.T., Head, J.W., Sun, X. (2023). A New View of the Lunar South Pole from the Lunar Orbiter Laser Altimeter (LOLA). The Planetary Science Journal 4, 183. doi:10.3847/PSJ/acf3e1. Data doi:10.60903/gsfcpgda-lola-spole.",
   "url": "https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/data_derived_prp/dlre_prp_south.tab"
  },
  "ice": "predicted",
  "evidence": [
   {
    "instrument": "LRO Diviner thermal model and LOLA shadow model",
    "finding": "Temperature and shadow maps predict cold traps here, but the reviewed map of reported ice signals has no detection assigned to this crater.",
    "citation": "Paige, D.A., et al. (2010). Diviner Lunar Radiometer observations of cold traps in the Moon's south polar region. Science 330, 479-482. doi:10.1126/science.1187726. Dataset: Paige et al. (2018), LRO DLRE Level 5 PRP V2.0, NASA PDS, LRO-L-DLRE-5-PRP-V2.0. Barker, M.K., Mazarico, E., Neumann, G.A., Smith, D.E., Zuber, M.T., Head, J.W., Sun, X. (2023). A New View of the Lunar South Pole from the Lunar Orbiter Laser Altimeter (LOLA). The Planetary Science Journal 4, 183. doi:10.3847/PSJ/acf3e1. Data doi:10.60903/gsfcpgda-lola-spole.",
    "url": "https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/data_derived_prp/dlre_prp_south.tab"
   }
  ],
  "diameterKm": 103.39
 },
 {
  "id": "ice-ice-slater",
  "kind": "ice",
  "name": "Slater",
  "lat": -88.0792,
  "lon": 111.2881,
  "short": "Cold traps are predicted here; no detection is mapped here",
  "detail": "Temperature and shadow maps predict cold traps here, but the reviewed map of reported ice signals has no detection assigned to this crater.",
  "source": {
   "name": "Paige, D.A., et al. (2010). Diviner Lunar Radiometer observations of cold traps in the Moon's south polar region. Science 330, 479-482. doi:10.1126/science.1187726. Dataset: Paige et al. (2018), LRO DLRE Level 5 PRP V2.0, NASA PDS, LRO-L-DLRE-5-PRP-V2.0. Barker, M.K., Mazarico, E., Neumann, G.A., Smith, D.E., Zuber, M.T., Head, J.W., Sun, X. (2023). A New View of the Lunar South Pole from the Lunar Orbiter Laser Altimeter (LOLA). The Planetary Science Journal 4, 183. doi:10.3847/PSJ/acf3e1. Data doi:10.60903/gsfcpgda-lola-spole.",
   "url": "https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/data_derived_prp/dlre_prp_south.tab"
  },
  "ice": "predicted",
  "evidence": [
   {
    "instrument": "LRO Diviner thermal model and LOLA shadow model",
    "finding": "Temperature and shadow maps predict cold traps here, but the reviewed map of reported ice signals has no detection assigned to this crater.",
    "citation": "Paige, D.A., et al. (2010). Diviner Lunar Radiometer observations of cold traps in the Moon's south polar region. Science 330, 479-482. doi:10.1126/science.1187726. Dataset: Paige et al. (2018), LRO DLRE Level 5 PRP V2.0, NASA PDS, LRO-L-DLRE-5-PRP-V2.0. Barker, M.K., Mazarico, E., Neumann, G.A., Smith, D.E., Zuber, M.T., Head, J.W., Sun, X. (2023). A New View of the Lunar South Pole from the Lunar Orbiter Laser Altimeter (LOLA). The Planetary Science Journal 4, 183. doi:10.3847/PSJ/acf3e1. Data doi:10.60903/gsfcpgda-lola-spole.",
    "url": "https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/data_derived_prp/dlre_prp_south.tab"
   }
  ],
  "diameterKm": 25.12
 },
 {
  "id": "ice-ice-wiechert",
  "kind": "ice",
  "name": "Wiechert",
  "lat": -84.0334,
  "lon": 164.701,
  "short": "Cold traps are predicted here; no detection is mapped here",
  "detail": "Temperature and shadow maps predict cold traps here, but the reviewed map of reported ice signals has no detection assigned to this crater.",
  "source": {
   "name": "Paige, D.A., et al. (2010). Diviner Lunar Radiometer observations of cold traps in the Moon's south polar region. Science 330, 479-482. doi:10.1126/science.1187726. Dataset: Paige et al. (2018), LRO DLRE Level 5 PRP V2.0, NASA PDS, LRO-L-DLRE-5-PRP-V2.0. Barker, M.K., Mazarico, E., Neumann, G.A., Smith, D.E., Zuber, M.T., Head, J.W., Sun, X. (2023). A New View of the Lunar South Pole from the Lunar Orbiter Laser Altimeter (LOLA). The Planetary Science Journal 4, 183. doi:10.3847/PSJ/acf3e1. Data doi:10.60903/gsfcpgda-lola-spole.",
   "url": "https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/data_derived_prp/dlre_prp_south.tab"
  },
  "ice": "predicted",
  "evidence": [
   {
    "instrument": "LRO Diviner thermal model and LOLA shadow model",
    "finding": "Temperature and shadow maps predict cold traps here, but the reviewed map of reported ice signals has no detection assigned to this crater.",
    "citation": "Paige, D.A., et al. (2010). Diviner Lunar Radiometer observations of cold traps in the Moon's south polar region. Science 330, 479-482. doi:10.1126/science.1187726. Dataset: Paige et al. (2018), LRO DLRE Level 5 PRP V2.0, NASA PDS, LRO-L-DLRE-5-PRP-V2.0. Barker, M.K., Mazarico, E., Neumann, G.A., Smith, D.E., Zuber, M.T., Head, J.W., Sun, X. (2023). A New View of the Lunar South Pole from the Lunar Orbiter Laser Altimeter (LOLA). The Planetary Science Journal 4, 183. doi:10.3847/PSJ/acf3e1. Data doi:10.60903/gsfcpgda-lola-spole.",
    "url": "https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/data_derived_prp/dlre_prp_south.tab"
   }
  ],
  "diameterKm": 40.82
 },
 {
  "id": "ice-ice-peary",
  "kind": "ice",
  "name": "Peary",
  "lat": 88.6251,
  "lon": 24.4024,
  "short": "Radar signs seen from orbit; ice is possible, not measured here",
  "detail": "Radar found unusual signals in small craters inside Peary that may come from buried ice. Rough ground also changes radar signals; no water was measured on the spot, and this is not a claim about the whole crater. The Mini-RF team described radar signals consistent with possible ice in permanently shaded small craters inside Peary. These are orbital signs with more than one possible cause.",
  "source": {
   "name": "ISRO (2020). Chandrayaan-2 completes a year around the Moon, pp. 9–10, Figure 9. See also Bussey, D.B.J., Spudis, P.D., and the Mini-RF Team (2011). New insights into lunar processes and history from global mapping by Mini-RF radar. LPSC 42, abstract 2086.",
   "url": "https://www.isro.gov.in/media_isro/pdf/chandrayaan-2_completes_a_year_around_the_moon_.pdf"
  },
  "ice": "detected",
  "evidence": [
   {
    "instrument": "Chandrayaan-2 Dual-frequency Synthetic Aperture Radar (DFSAR)",
    "finding": "Radar found unusual signals in small craters inside Peary that may come from buried ice. Rough ground also changes radar signals; no water was measured on the spot, and this is not a claim about the whole crater.",
    "citation": "ISRO (2020). Chandrayaan-2 completes a year around the Moon, pp. 9–10, Figure 9. See also Bussey, D.B.J., Spudis, P.D., and the Mini-RF Team (2011). New insights into lunar processes and history from global mapping by Mini-RF radar. LPSC 42, abstract 2086.",
    "url": "https://www.isro.gov.in/media_isro/pdf/chandrayaan-2_completes_a_year_around_the_moon_.pdf"
   },
   {
    "instrument": "LRO Mini-RF and Chandrayaan-1 Mini-SAR",
    "finding": "The Mini-RF team described radar signals consistent with possible ice in permanently shaded small craters inside Peary. These are orbital signs with more than one possible cause.",
    "citation": "Bussey, D.B.J., Spudis, P.D., and the Mini-RF Team (2011). New insights into lunar processes and history from global mapping by Mini-RF radar. LPSC 42, abstract 2086.",
    "url": "https://www.lpi.usra.edu/meetings/lpsc2011/pdf/2086.pdf"
   }
  ],
  "diameterKm": 78.75
 },
 {
  "id": "ice-ice-rozhdestvenskiy",
  "kind": "ice",
  "name": "Rozhdestvenskiy",
  "lat": 84.9943,
  "lon": -157.8924,
  "short": "Radar signs seen from orbit; ice is possible, not measured here",
  "detail": "Radar found unusual signals in small craters inside Rozhdestvenskiy that may come from buried ice. Rough ground can give similar signals; no water was measured on the spot, and this is not a claim about the whole crater. A high radar polarisation ratio can come from rough rock or from ice. The instrument does not directly measure water in the ground.",
  "source": {
   "name": "NASA/GSFC/JHUAPL. Mini RF Rozhdestvenskiy. Bussey, D.B.J., Spudis, P.D., and the Mini-RF Team (2011). New insights into lunar processes and history from global mapping by Mini-RF radar. LPSC 42, abstract 2086. Spudis et al. (2010), GRL 37, L06204, doi:10.1029/2009GL042259.",
   "url": "https://science.nasa.gov/image-detail/rozhdestvenskiy-x-main-context-580/"
  },
  "ice": "detected",
  "evidence": [
   {
    "instrument": "LRO Mini-RF and Chandrayaan-1 Mini-SAR",
    "finding": "Radar found unusual signals in small craters inside Rozhdestvenskiy that may come from buried ice. Rough ground can give similar signals; no water was measured on the spot, and this is not a claim about the whole crater.",
    "citation": "NASA/GSFC/JHUAPL. Mini RF Rozhdestvenskiy. Bussey, D.B.J., Spudis, P.D., and the Mini-RF Team (2011). New insights into lunar processes and history from global mapping by Mini-RF radar. LPSC 42, abstract 2086. Spudis et al. (2010), GRL 37, L06204, doi:10.1029/2009GL042259.",
    "url": "https://science.nasa.gov/image-detail/rozhdestvenskiy-x-main-context-580/"
   },
   {
    "instrument": "Radar interpretation limits",
    "finding": "A high radar polarisation ratio can come from rough rock or from ice. The instrument does not directly measure water in the ground.",
    "citation": "NASA (2010). NASA Radar Finds Ice Deposits at Moon’s North Pole, 2 March 2010; the article explains that circular polarisation ratio is not uniquely diagnostic of roughness or ice.",
    "url": "https://science.nasa.gov/missions/mini-rf/nasa-radar-finds-ice-deposits-at-moons-north-pole/"
   }
  ],
  "diameterKm": 181.15
 },
 {
  "id": "ice-ice-hermite",
  "kind": "ice",
  "name": "Hermite",
  "lat": 86.1659,
  "lon": -93.3152,
  "short": "Radar signs seen from orbit; ice is possible, not measured here",
  "detail": "Mini-RF reported unusual radar signals in small craters on Hermite’s floor. A scattering model favours possible buried ice, but roughness can affect the signal; no water was measured on the spot. Diviner measured very cold ground in Hermite, and LOLA models show lasting shadow in part of its south-western floor. Cold and shadow allow possible ice storage; they do not measure water.",
  "source": {
   "name": "Spudis, P.D., et al. (2013). Evidence for water ice on the Moon: Results for anomalous polar craters from the LRO Mini-RF imaging radar. JGR Planets 118, 2016–2029, Table 3 and Figure 7. doi:10.1002/jgre.20156.",
   "url": "https://ntrs.nasa.gov/api/citations/20150000268/downloads/20150000268.pdf"
  },
  "ice": "detected",
  "evidence": [
   {
    "instrument": "LRO Mini-RF imaging radar",
    "finding": "Mini-RF reported unusual radar signals in small craters on Hermite’s floor. A scattering model favours possible buried ice, but roughness can affect the signal; no water was measured on the spot.",
    "citation": "Spudis, P.D., et al. (2013). Evidence for water ice on the Moon: Results for anomalous polar craters from the LRO Mini-RF imaging radar. JGR Planets 118, 2016–2029, Table 3 and Figure 7. doi:10.1002/jgre.20156.",
    "url": "https://ntrs.nasa.gov/api/citations/20150000268/downloads/20150000268.pdf"
   },
   {
    "instrument": "LRO Diviner temperature measurements and LOLA shadow models",
    "finding": "Diviner measured very cold ground in Hermite, and LOLA models show lasting shadow in part of its south-western floor. Cold and shadow allow possible ice storage; they do not measure water.",
    "citation": "NASA/GSFC/JHUAPL. Hermite Crater; Diviner temperature observations and LOLA long-term illumination modelling. See also NASA LRO, Taking the Moon’s Temperature.",
    "url": "https://science.nasa.gov/image-detail/hermite/"
   }
  ],
  "diameterKm": 108.64
 },
 {
  "id": "ice-ice-erlanger",
  "kind": "ice",
  "name": "Erlanger",
  "lat": 86.9883,
  "lon": 28.6166,
  "short": "Radar signs seen from orbit; ice is possible, not measured here",
  "detail": "Mini-RF reported unusual radar signals inside Erlanger. A scattering model favours possible buried ice, but roughness can affect the signal; no water was measured on the spot. LROC shows that much of Erlanger’s floor stays in permanent shadow. Shadow can help ice last in suitable cold patches; the photograph alone is not an ice detection.",
  "source": {
   "name": "Spudis, P.D., et al. (2013). Evidence for water ice on the Moon: Results for anomalous polar craters from the LRO Mini-RF imaging radar. JGR Planets 118, 2016–2029, Table 3. doi:10.1002/jgre.20156.",
   "url": "https://ntrs.nasa.gov/api/citations/20150000268/downloads/20150000268.pdf"
  },
  "ice": "detected",
  "evidence": [
   {
    "instrument": "LRO Mini-RF imaging radar",
    "finding": "Mini-RF reported unusual radar signals inside Erlanger. A scattering model favours possible buried ice, but roughness can affect the signal; no water was measured on the spot.",
    "citation": "Spudis, P.D., et al. (2013). Evidence for water ice on the Moon: Results for anomalous polar craters from the LRO Mini-RF imaging radar. JGR Planets 118, 2016–2029, Table 3. doi:10.1002/jgre.20156.",
    "url": "https://ntrs.nasa.gov/api/citations/20150000268/downloads/20150000268.pdf"
   },
   {
    "instrument": "LRO Narrow Angle Camera (LROC NAC)",
    "finding": "LROC shows that much of Erlanger’s floor stays in permanent shadow. Shadow can help ice last in suitable cold patches; the photograph alone is not an ice detection.",
    "citation": "NASA/GSFC/Arizona State University (2009). Eternal Darkness Near the North Pole, PIA12899. LROC Permanently Shadowed Regions Atlas, Erlanger entry NP_869610_0287570.",
    "url": "https://science.nasa.gov/photojournal/eternal-darkness-near-the-north-pole/"
   }
  ],
  "diameterKm": 10.94
 },
 {
  "id": "ice-ice-bosch",
  "kind": "ice",
  "name": "Bosch",
  "lat": 86.8175,
  "lon": 133.5429,
  "short": "Cold ground could keep ice; this marker is a prediction",
  "detail": "NASA lists Bosch among the very cold northern craters that could trap water ice. This is a prediction from cold conditions, not a measurement of water at this crater.",
  "source": {
   "name": "Borowski, S.K., et al. (2018). Robust Exploration and Commercial Missions to the Moon Using Nuclear Thermal Rocket Propulsion and In Situ Propellants Derived from Lunar Polar Ice Deposits. NASA/TM—2018-219937, p. 7 and Figure 4(b).",
   "url": "https://ntrs.nasa.gov/api/citations/20180008495/downloads/20180008495.pdf"
  },
  "ice": "predicted",
  "evidence": [
   {
    "instrument": "LRO Diviner temperature measurements",
    "finding": "NASA lists Bosch among the very cold northern craters that could trap water ice. This is a prediction from cold conditions, not a measurement of water at this crater.",
    "citation": "Borowski, S.K., et al. (2018). Robust Exploration and Commercial Missions to the Moon Using Nuclear Thermal Rocket Propulsion and In Situ Propellants Derived from Lunar Polar Ice Deposits. NASA/TM—2018-219937, p. 7 and Figure 4(b).",
    "url": "https://ntrs.nasa.gov/api/citations/20180008495/downloads/20180008495.pdf"
   }
  ],
  "diameterKm": 19.58
 }
];
