"""Original Trailbook B vector artwork. 24-unit grid, currentColor only."""
from pathlib import Path
import json, re, html, zipfile, hashlib
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT
OUT.mkdir(parents=True, exist_ok=True)
(OUT / 'svg').mkdir(exist_ok=True)
CAT = json.loads((ROOT / 'source/catalog.json').read_text(encoding='utf-8-sig'))
I = {}

def p(d, w=2.5):
    return f'<path d="{d}" fill="none" stroke="currentColor" stroke-width="{w}" stroke-linecap="round" stroke-linejoin="round"/>'
def f(d):
    return f'<path d="{d}" fill="currentColor"/>'
def c(x,y,r,solid=True,w=1.8):
    return f'<circle cx="{x}" cy="{y}" r="{r}" fill="'+('currentColor"/>' if solid else f'none" stroke="currentColor" stroke-width="{w}"/>')
def rect(x,y,w,h,r=0,solid=True):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="'+('currentColor"/>' if solid else 'none" stroke="currentColor" stroke-width="1.8"/>')
def g(body,transform):
    return f'<g transform="{transform}">{body}</g>'
def human(head,body,limbs):
    return c(*head,2)+f(body)+p(limbs)
def waves(y=18):
    return p(f'M2 {y}q2-2 4 0t4 0 4 0 4 0 4 0',1.8)
def small(base,mark):
    # Subtype mark gets a dedicated 6-unit strip, never erases the silhouette.
    return g(base,'translate(1 .5) scale(.84)')+mark
def bottom(base,mark):
    return g(base,'translate(2 0) scale(.82)')+mark
def topmark(base,mark):
    return g(base,'translate(0 5) scale(.78)')+mark
def wheels():
    return c(5,17,3.6,False)+c(19,17,3.6,False)

# Preserve the selected prototypes for the six approved activity families.
prototype=(ROOT/'source/prototypes.svg').read_text(encoding='utf-8')
for key,body in re.findall(r'<symbol id="b-([^"]+)" viewBox="0 0 24 24">(.*?)</symbol>',prototype,re.S):
    I['ride' if key=='cycle' else key]=body.strip()

# Yoga: separate crossed shins and open triangular negative spaces, no solid base.
I['yoga']=c(12,3.4,2)+f('M9.1 8c.3-1.5 5.5-1.5 5.8 0L14 14h-4Z')+p('m9.6 8.2-3 4.6H3M14.4 8.2l3 4.6H21',2.3)+p('M10 15.5 6.5 16c-2.6.4-3.4 3.5-.7 4.3L16 22M14 15.5l3.5.5c2.1.3 3.1 2.4 1.6 3.5M16.5 17.8 6 22',2.15)

# Running: terrain and venue cues occupy a separate strip.
I['trail_run']=bottom(I['run'],p('m2 22 5-3 4 3 5-2 6 2',1.8))
I['treadmill_run']=g(I['run'],'translate(2 0) scale(.76)')+p('M3 20h17M17 19V9h4M5 22h12',1.8)
I['indoor_run']=topmark(I['run'],p('m2 6 10-4 10 4',1.8))
I['track_run']=bottom(I['run'],'<ellipse cx="12" cy="21" rx="9.5" ry="1.7" fill="none" stroke="currentColor" stroke-width="1.6"/>')
I['virtual_run']=g(I['run'],'translate(3 1) scale(.69)')+p('M3 17V3h4M18 3h3v14H3M9 21h6M12 17v4',1.8)
I['ultra_run']=bottom(I['run'],p('M12 21c-2-4-7-4-7-1s5 3 7 0 7-3 7 0-5 3-7 1',1.6))
I['obstacle_run']=g(I['run'],'translate(0 -1) scale(.9)')+p('M15 22v-5h7v5',1.8)
wheelchair=c(13,3.5,2)+p('M11.8 8 10 13h7l3 6h2M11.8 8l4 1.5L18 8',2.5)+p('M7.5 10a5.5 5.5 0 1 0 7.5 6',2.1)
I['wheelchair_walk']=wheelchair
I['wheelchair_run']=g(wheelchair,'translate(3 0) scale(.88)')+p('M2 7h4M1.5 10h3',1.8)

# Cycling variants; familiar rider silhouette with restrained context marks.
I['road_ride']=bottom(I['ride'],p('M3 22h6m6 0h6',1.8))
I['mtb_ride']=bottom(I['ride'],p('m2 22 4-3 4 3 5-4 7 4',1.8))
I['gravel_ride']=bottom(I['ride'],c(3,21,1)+c(7,22,1)+c(11,20.5,1)+c(15,22,1)+c(20,21,1))
I['cyclocross']=bottom(I['ride'],p('M4 22v-3h5v3M15 22v-3h5v3',1.7))
I['downhill_ride']=g(I['ride'],'translate(3 -1) rotate(13 12 12) scale(.8)')+p('m2 19 20 3',1.8)
I['enduro_ride']=bottom(I['ride'],p('m2 22 5-4 4 4 5-3 6 3',1.8)+p('m17 19 3 1-1-3',1.4))
stationary=c(14,3.5,2)+f('m11 6 3 2-4 5-3-2Z')+p('m12 8 5 2h3M9 11l4 3-2 4',2.5)+c(8,17,3.3,False)+p('M5 21h14M17 10v11',1.8)
I['indoor_ride']=stationary
I['spin']=g(stationary,'translate(0 1) scale(.92)')+p('M19 3v4M19 3l3 1',1.8)+c(18.2,8,1.3)
I['virtual_ride']=g(I['ride'],'translate(2 3) scale(.75)')+p('M2 19V2h20v17H2M9 22h6M12 19v3',1.7)
bolt=f('m21 2-4 6h3l-1 5 4-7h-3Z')
I['ebike_ride']=g(I['ride'],'translate(0 3) scale(.84)')+bolt
I['emtb_ride']=g(I['ride'],'translate(0 1) scale(.8)')+bolt+p('m2 22 5-3 5 3 5-3 5 3',1.7)
I['commute_ride']=g(I['ride'],'translate(0 5) scale(.78)')+rect(14,2,8,5,1,False)+p('M16 2V1h4v1',1.5)
I['track_ride']=bottom(I['ride'],'<ellipse cx="12" cy="21" rx="10" ry="1.6" fill="none" stroke="currentColor" stroke-width="1.6"/>')
I['bmx']=c(13,3,2)+p('m11 7-3 4 5 1 2 4M11 7l4 2h4',2.5)+c(5,18,3.1,False)+c(19,16,3.1,False)+p('m5 18 6-5 8 3',1.6)
I['handcycle']=c(10,5,2)+p('m9 9-2 5 7 1 3 4M9 9l4 2 3-2',2.5)+c(6,17,4,False)+c(20,19,2.5,False)+p('m10 19 10 0M14 15l2-6',1.7)
I['recumbent']=c(6,7,2)+p('m6 11 4 5 6-4 3 4M7 12l5-1',2.5)+c(5,18,3.4,False)+c(19,18,3.4,False)+p('M7 18h8',1.8)

# Swimming, walking and hiking.
I['pool_swim']=g(I['swim'],'translate(2 0) scale(.82)')+p('M2 22h20M2 20v2M22 20v2',1.8)
I['open_water_swim']=I['swim']+c(21,3,1.2,False,1.5)
I['speed_walk']=g(I['walk'],'translate(3 0) scale(.92)')+p('M2 8h4M1 11h3',1.8)
I['indoor_walk']=topmark(I['walk'],p('m2 6 10-4 10 4',1.8))
I['rucking']=I['walk']+f('M7.2 6.5h2L7.8 12h-2c-1 0-1.2-.7-.9-1.5l.8-2.8c.2-.8.7-1.2 1.5-1.2Z')
I['hike']=g(I['rucking'],'translate(-1 0)')+p('m19 10-2 12',1.8)
I['mountaineering']=g(I['hike'],'translate(-1 0) scale(.84)')+p('m14 22 5-10 4 10M17 16h4',1.6)

# Winter sports.
skier=human((13,3.5),'m11 6 3 2-4 5-3-2Z','m12 8 4 2h3M8 11l6 4-2 4')
I['ski_alpine']=skier+p('M3 19q8 3 17 2M3 22h15M18 10l3 9',1.7)
I['ski_backcountry']=g(I['hike'],'translate(1 -1) scale(.87)')+p('m2 22 19-4M3 19l14-3',1.7)
I['ski_xc']=g(I['run'],'translate(1 0) scale(.85)')+p('M2 22h20M2 19h8M6 9 3 18M19 9l2 10',1.6)
I['ski_skate']=g(I['walk'],'translate(1 -1) scale(.85)')+p('m2 18 9 4m3-1 8-5M6 9 3 17M18 10l3 6',1.7)
I['ski_indoor']=g(c(11,4,2)+p('m11 8-1 5 4 3-1 5M10 13l-4 7M11 8l5 3M11 8l-4 3',2.5),'translate(2 3) scale(.8)')+p('M3 2h18M4 2v20M20 2v20M2 22h20M7 2v8M16 2v8',1.6)
I['snowboard']=human((13,3.5),'m11 7 3 1-2 6-3-1Z','m11.5 8-5 2-3-1M13 8l4 3h3M11 13l-5 5M11 13l5 4')+p('M3 19q8 6 18-1',2.4)
I['snowshoe']=g(I['hike'],'translate(2 0) scale(.8)')+'<g fill="none" stroke="currentColor" stroke-width="1.8"><ellipse cx="7" cy="20" rx="4.5" ry="1.7"/><ellipse cx="17" cy="19" rx="4.5" ry="1.7"/></g>'
I['ice_skate']=g(I['run'],'translate(1 0) scale(.85)')+p('M2 18h5M10 22h8M13 19v3M4 16v2',1.8)
I['winter_other']=p('M12 2v20M3.3 7l17.4 10M3.3 17 20.7 7',2.3)+p('m8 4 4 3 4-3M8 20l4-3 4 3M3 11l4-1V6M21 13l-4 1v4M3 13l4 1v4M21 11l-4-1V6',1.8)

# Paddle and board sports use bold people with thinner equipment.
seated=human((11,5),'M9 8h4l-1 6H9Z','m11 10 5 3M10 14l5 1 3 3')
hull=p('M2 18h20q-3 4-10 4T2 18Z',1.8)
I['row']=seated+hull+p('M4 10 20 19M17 18l3 2',2)
I['kayak']=c(12,5,2)+p('M12 9v6M12 10l-5 3M12 10l5 3',2.5)+p('M2 18q10-6 20 0-10 6-20 0Z',1.8)+p('M3 8 21 17',1.8)+p('m2 7 3 2m14 7 3 2',3.2)
I['canoe']=seated+hull+p('m18 9-3 12',1.8)+p('m15.5 18-.7 3',3.5)
I['paddle']=c(11,4,2)+p('M11 8v5l5 3M11 9l6 1M11 13l-5 3',2.5)+hull+p('m20 6-2 15',1.8)
standing=human((11,3.5),'M9 7h4l1 7-3 1-2-4Z','M11 14l-5 5M12 14l5 5M11 8l6 3')
board=p('M2 21q10 3 20-1',2)
I['sup']=standing+board+p('M20 6v14',1.8)+p('M20 18v3',3.4)
I['surf']=g(human((13,4),'m11 7 3 1-2 6-3-1Z','m11 8-5 3-3-1M13 8l5 2h3M11 13l-5 5M11 13l6 4')+board,'translate(1 0) scale(.88)')+waves(22)
I['windsurf']=g(standing,'translate(-1 3) scale(.8)')+p('M15 3v17M15 3l7 13h-7',1.8)+board
I['kitesurf']=g(standing,'translate(1 7) scale(.65)')+board+p('M5 3q7-4 14 0l-2 4q-5-3-10 0ZM7 7l5 6M17 7l-5 6',1.6)
I['sail']=p('M12 2v16M12 3 3 16h9M15 6l6 10h-6M2 19h20l-3 3H5Z',2)
I['rafting']=c(8,6,1.8)+c(16,6,1.8)+p('M8 10v5M16 10v5M8 11l-4 2M16 11l4 2',2.5)+p('M4 16h16q3 0 2 3l-2 3H4l-2-3q-1-3 2-3Z',2)+p('M3 11 1 20M21 11l2 9',1.6)
towed=human((10,4),'M8 7h4l1 7-3 1-2-5Z','m10 9 5 3 4-2M11 14l-5 5M11 14l7 4')+p('m18 9 3 3M20 10l3-4',1.6)
I['wakeboard']=towed+board
I['wakesurf']=g(I['surf'],'translate(1 0) scale(.9)')+p('M18 3h4l-1 3h-3',1.6)
I['water_ski']=towed+p('M2 21h9M13 21h9',2)
swimmer=human((18,9),'m7 10 8 1-1 4-8-2Z','M8 11 4 8 2 9M7 13l-4 4M14 12l5 2')
I['snorkel']=swimmer+p('M20 10h2V4h-3',1.8)+waves(21)
I['dive']=swimmer+rect(7,6,8,3,1.4)+p('M2 16 1 20l4-2',2)+c(20,4,1,False,1.4)+c(22,1.5,.6)
I['apnea']=g(swimmer,'rotate(35 12 12)')+p('M2 17 1 22l4-2',2)+c(21,3,1,False,1.4)
I['boating']=f('M2 14h20l-4 5H6Z')+p('M7 12V7h9l3 5M9 7V4h4',1.8)+waves(22)
I['water_other']=f('M12 2C9 7 5 11 5 15a7 7 0 0 0 14 0c0-4-4-8-7-13Z')

# Fitness and mind/body.
I['strength']=rect(3,6,4,12,1)+rect(17,6,4,12,1)+rect(1,9,2,6,.7)+rect(21,9,2,6,.7)+p('M7 12h10',3)
I['hiit']=c(12,13,8.5,False,2.2)+p('M9.5 1.5h5M12 1.5v3M18.5 5.5 20 4',2.2)+f('M12 6.8a6.2 6.2 0 0 1 6.2 6.2H12Z')+p('M12 13 8.5 16.5',2.1)+c(12,13,1.15)
I['cardio']=p('M3 12H1m2-4C3 2 10 2 12 6c2-4 9-4 9 2 0 5-9 13-9 13s-4-3-6-6',2)+p('M4 12h4l2-4 3 8 2-4h7',2.3)
I['training']=c(12,3,2)+p('M12 7v7M12 8 6 6 3 3M12 8l6-2 3-3M12 14 6 21M12 14l6 7',2.8)
I['gym_equipment']=p('M3 22V3h18v19M3 3h18M6 22h12',1.8)+rect(9,15,6,3,.6)+rect(9,19,6,3,.6)+p('M12 3v10M9 10l3 3 3-3',2)
I['elliptical']=c(12,3.3,2)+p('m11 7-1 6 5 2 1 5M10 13l-5 7M11 8l6 3',2.5)+p('M19 5 17 20M3 21h6M14 21h6',1.8)+c(11,18,2.5,False,1.6)
stairs=p('M2 22h6v-4h6v-4h8',1.8)
stepper=human((13,3),'m11 6 3 1-2 6-3-1Z','m12 8 5 3M11 8 7 9M11 13l5 1-1 4M10 13l-5 6')
I['stair_stepper']=g(stepper,'scale(.9)')+p('M3 21h7M14 18h7M19 18V7h3',1.8)
I['floor_climb']=g(stepper,'scale(.9)')+stairs
I['indoor_row']=seated+p('M2 20h20M7 17h10M19 18l1-8M15 12h5',1.8)+c(4,17,2.5,False)
I['jump_rope']=c(12,4,2)+p('M12 8v6M12 9l-6 3M12 9l6 3M12 14l-3 5M12 14l4 4',2.5)+p('M5 11c-8 13 22 16 14 0',1.7)
I['dance']=c(12,3,2)+p('m12 7-1 7M12 8 7 6 5 2M12 8l5 3 4-2M11 14l-5 3-3-2M11 14l5 7',2.8)
I['warm_up']=c(12,3,2)+p('M12 7v7M12 9 5 7M12 9l7-2M12 14l-5 7M12 14l5 7',2.6)+p('M3 4 1 7l2 3M21 4l2 3-2 3',1.6)
I['pilates']=c(5,14,2)+p('M9 14h5l6-9M14 14l5 4M8 16l-4 4',2.8)+p('M2 23h20',1.8)
I['stretching']=c(14,4,2)+p('m13 8-3 6-6 6M10 14l8 6M13 8l-5 3-3 5M13 8l4 4 3 6',2.7)+p('M2 23h20',1.7)
I['mobility']=c(12,5,2)+p('M12 9v6M12 10 6 8M12 10l6-2M12 15l-5 6M12 15l5 6',2.7)+p('M3 12a9 9 0 0 1 3-8M3 12l-1-3m1 3 3-1M21 12a9 9 0 0 1-3 8M21 12l1 3m-1-3-3 1',1.5)
I['meditation']=c(12,3.4,2)+f('M9.5 8c.2-1.5 4.8-1.5 5 0L14 14h-4Z')+p('m10 8.5-3 5-3 1M14 8.5l3 5 3 1',2.3)+p('M10 16 6 17q-4 2 0 4l11-4q4 2 1 4H8',2.1)
I['breathwork']=p('M12 3v8M12 8 9 11M12 8l3 3',2.2)+f('M9 7C6 7 2 14 2 18c0 4 8 3 8 0v-6L8 13Z M15 7c3 0 7 7 7 11 0 4-8 3-8 0v-6l2 1Z')

# Climbing context: natural rock, discrete indoor holds, low boulder.
I['indoor_climb']=re.sub(r'<path d="m21 2-1.5 5 1.5 5-1.5 5L21 22"[^>]*/>','',I['climb'])+rect(20,3,3,2,1)+rect(19,10,3,2,1)+rect(20,18,3,2,1)
I['bouldering']=c(12,5,2)+p('m11 9-3 4 5 2 1 5M8 13l-4 4M11 9l5 1 2-4M11 9 7 7 5 3',2.5)+p('M18 3h4v19H2',1.7)

# Racket revision: the frame, strings, throat and grip rotate together.
# Each sport uses its own head profile; perforations are transparent cutouts.
def oval(x,y,rx,ry,w=2.15):
    return f'<ellipse cx="{x}" cy="{y}" rx="{rx}" ry="{ry}" fill="none" stroke="currentColor" stroke-width="{w}"/>'
def perforated(outline,holes):
    cuts=''.join(f'M{x-r} {y}a{r} {r} 0 1 0 {2*r} 0a{r} {r} 0 1 0 {-2*r} 0Z' for x,y,r in holes)
    return f'<path fill="currentColor" fill-rule="evenodd" d="{outline} {cuts}"/>'
tilt='rotate(35 12 12)'
tennis_head=oval(12,7.8,4.8,6)+p('M10.4 2.8v10M13.6 2.8v10M7.6 5.8h8.8M7.5 9.7h9',.95)
tennis_neck=p('m9.8 13.1 2.2 3.6 2.2-3.6',1.75)+p('M12 16.8v4.7',2.9)
I['tennis']=g(tennis_head+tennis_neck,tilt)+c(20.5,20,1.9)
padel_head=perforated('M12 1.8a5.7 5.7 0 1 1 0 11.4 5.7 5.7 0 1 1 0-11.4Z',[(10,5.5,.95),(14,5.5,.95),(12,7.5,.95),(10,9.5,.95),(14,9.5,.95)])
I['padel']=g(padel_head+p('m9.6 12.2 2.4 4 2.4-4',1.9)+p('M12 16.2v5.3',3.1),tilt)+c(20.5,20,1.8)
pickle_head=f('M9 2h6q2.7 0 2.7 2.7v6.6q0 2.1-2 2.8l-2.2 1.1v6.3h-3v-6.3l-2.2-1.1q-2-.7-2-2.8V4.7Q6.3 2 9 2Z')
pickle_ball=perforated('M22.8 19.5a2.8 2.8 0 1 1-5.6 0 2.8 2.8 0 1 1 5.6 0Z',[(19,18.8,.6),(21,18.8,.6),(20,20.5,.6)])
I['pickleball']=g(pickle_head,tilt)+pickle_ball
squash_head=p('M12 2c6 0 6.8 6.7 3.8 10L12 16l-3.8-4C5.2 8.7 6 2 12 2Z',2.1)+p('M10.5 3v10.7M13.5 3v10.7M7.6 6h8.8M8 10h8',.95)
I['squash']=g(squash_head+p('M12 16v5.5',2.9),tilt)+c(20.5,20,1.6)
badminton_head=oval(10,6.4,3.5,4.6,1.9)+p('M10 2v8.7M6.6 6.4h6.8',1)+p('M10 11v6',1.7)+p('M10 17v5',2.8)
shuttle=p('m17.5 3 1.2 6.7h2.6L23 3ZM19.3 3l.5 6.4M21.2 3l-.7 6.4',1.35)+f('M18.7 10.6h2.6v.7a1.3 1.3 0 0 1-2.6 0Z')
I['badminton']=g(badminton_head,'translate(-1.7 0) rotate(24 10 12)')+g(shuttle,'translate(-.3 .5)')
table_head=f('M12 2c8.3 0 8.2 10.3 1.8 13h-3.6C3.8 12.3 3.7 2 12 2Z')
I['table_tennis']=g(table_head+p('M12 15.8v5.7',3.5),tilt)+c(20.5,19,2.1)
racquet_head=p('M12 2C5 2 4.8 8 8 11.5L12 15l4-3.5C19.2 8 19 2 12 2Z',2.2)+p('M10.3 3v9M13.7 3v9M6.7 6h10.6M7.7 10h8.6',.95)
I['racquetball']=g(racquet_head+p('M12 15v6.5',2.9),tilt)+c(20.5,20,2.3)
I['racket']=g(oval(12,7.8,4.8,6)+p('M12 2v11.5M7.3 7.8h9.4',1.1)+tennis_neck,tilt)

# Team sports.
I['soccer']=c(12,12,9.5,False,2.2)+f('m12 7 5 3-2 6H9l-2-6Z')+p('M12 2.5V7M21 9l-4 1M18 20l-3-4M6 20l3-4M3 9l4 1',1.6)
I['basketball']=c(12,12,9.5,False,2.2)+p('M2.5 12h19M12 2.5v19M5 5c7 5 7 9 0 14M19 5c-7 5-7 9 0 14',1.8)
I['volleyball']=c(12,12,9.5,False,2.2)+p('M12 12 7 3M12 12l10-1M12 12l-5 9M12 3c7 3 8 6 7 8M19 16c-5 4-8 3-10 2M4 17c-1-7 1-9 5-10',1.7)
I['hockey']=p('M6 3 15 18H8q-3 0-3 3h11q3 0 1-3L9 3',2.6)+rect(19,20,4,2,1)
I['rugby']='<ellipse cx="12" cy="12" rx="7" ry="11" transform="rotate(40 12 12)" fill="none" stroke="currentColor" stroke-width="2.2"/>'+p('m8 8 8 8M8 11l3-3M11 14l3-3M14 17l3-3',1.7)
I['american_football']=p('M3 21C1 10 10 1 21 3c2 11-7 20-18 18Z',2.2)+p('m7 17 10-10M8 13l3 3M11 10l3 3M14 7l3 3M4 12l8 8M12 4l8 8',1.5)
I['baseball']=c(8,16,5.5,False,2)+p('M5 12q4 4 0 8M10 12q-3 4 0 8',1.4)+p('m13 12 8-9',3.5)+p('m12 13-3 3',2.2)
I['cricket']=p('m7 16 12-13 3 3-12 13Z',2)+p('m8 18-4 4',3)+c(4,9,2.3)
I['lacrosse']=p('M11 3h10v5q-1 6-7 5L11 3ZM14 13 5 22',2.3)+p('m13 5 6 5M12 8h8M15 3l3 9',1.3)+c(4,6,2)
I['ultimate']=c(11,4,2)+p('m11 8-1 6 5 6M10 14l-6 6M11 9l6 3 5-2M11 9 6 8 3 11',2.5)+'<ellipse cx="20" cy="5" rx="3" ry="1.2" fill="none" stroke="currentColor" stroke-width="1.7"/>'
I['team_sport']=c(12,5,2.2)+c(4,8,1.8)+c(20,8,1.8)+f('M8 12c0-4 8-4 8 0v6H8ZM1 13c0-3 5-3 5 0v5H1ZM18 13c0-3 5-3 5 0v5h-5Z')+p('M10 18v4M14 18v4M3.5 18v3M20.5 18v3',2.2)

# Combat and multisport.
I['boxing']=f('M7 2h7q5 0 5 5v5l-3 5H7l-4-4V9q0-3 3-2V5q0-3 1-3Z')+rect(7,18,9,4,1)+p('M4 9v3l3 2',1.5)
I['mma']=human((12,3),'M10 7h4l-1 7h-3Z','m11 8-5 3-2-4M13 8l4 3 3-4M11 14l-5 7M12 14l7 4 3-2')
I['transition']=p('M3 7h17l-4-4M20 7l-4 4M21 17H4l4-4M4 17l4 4',2.7)
I['multisport']=p('M5 5a9 9 0 0 1 15 3M20 8V3M20 8h-5M19 19A9 9 0 0 1 4 16M4 16v5M4 16h5',2.3)+f('m13 7-5 6h4l-1 4 5-6h-4Z')
I['triathlon']=g(I['swim'],'translate(0 0) scale(.48)')+g(I['ride'],'translate(12 0) scale(.48)')+g(I['run'],'translate(6 12) scale(.48)')
I['duathlon']=g(I['run'],'translate(0 3) scale(.55)')+g(I['ride'],'translate(11 7) scale(.55)')
I['swimrun']=g(I['run'],'translate(1 -1) scale(.87)')+waves(21)

# Remaining activities.
I['golf']=c(11,3,2)+p('m11 7-2 6 5 7M9 13l-4 7M11 8l5 5',2.5)+p('m16 13 5 7h-3',1.8)+c(22,22,.8)
I['disc_golf']=p('M12 2v20M6 22h12M5 5h14M6 5l2 8h8l2-8M9 5l1 8M15 5l-1 8M5 14h14l-2 4H7Z',1.9)+'<ellipse cx="20" cy="3" rx="3" ry="1" fill="currentColor"/>'
I['horse_riding']=c(11,3,1.8)+p('M11 7v5l4 2',2.5)+f('M5 11h10l3-5 3 1 2 5-3 2-2-1-1 4H7l-2-3-2 1V9Z')+p('M7 16 5 22M15 16l3 6',2.3)
I['inline_skate']=g(I['run'],'translate(0 0) scale(.83)')+p('M2 17h5M10 20h6',1.5)+c(2,19,1)+c(6,19,1)+c(11,22,1)+c(15,22,1)
I['motor']=c(13,4,2)+p('m11 8-3 4 6 2M11 8l5 2h4',2.5)+wheels()+f('M5 13h6l4 4H7Z')+p('M18 9l2 8',1.8)
I['flying']=f('M11 2h2l1 7 8 5v2l-8-2v5l3 2v1l-5-1-5 1v-1l3-2v-5l-8 2v-2l8-5Z')
I['fishing']=c(7,5,2)+p('M7 9v6l5 6M7 15l-4 6M7 10l7 2',2.6)+p('M14 12 17 2q5 0 5 6v9q0 4-3 4t-3-4',1.7)
I['hunting']=p('M8 10 5 6V2M5 6 2 5M7 8l2-5M16 10l3-4V2M19 6l3-1M17 8l-2-5',2.1)+f('M7 10h10l2 3-3 7-4 3-4-3-3-7Z')
I['archery']=p('M5 2q16 10 0 20M5 2l5 10-5 10M2 12h20M18 8l4 4-4 4',2.1)
I['shooting']=c(12,12,8,False,2)+c(12,12,3,False,1.8)+c(12,12,1)+p('M12 1v5M12 18v5M1 12h5M18 12h5',1.9)
I['geocaching']=p('M12 22S4 14 4 9.5a8 8 0 0 1 16 0C20 14 12 22 12 22Z',2.1)+rect(8.5,6,7,6,1,False)+p('M12 6v6M8.5 8h7',1.4)
I['esports']=p('M7 6h10q4 0 5 11 0 5-5 1l-2-2H9l-2 2q-5 4-5-1Q3 6 7 6Z',2.2)+p('M5 10v5M2.5 12.5h5',2)+c(16,10,1)+c(19,13,1)
I['other']=p('M3 12h4l3-7 4 14 3-7h4',2.8)+c(3,12,1.4)+c(21,12,1.4)

# Compile exact local activity keys, no accidental generic substitutions.
expected={t['key'] for t in CAT['types']}
assert set(I)==expected, {'missing':sorted(expected-set(I)), 'extra':sorted(set(I)-expected)}
def svg(body):
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">'+body+'</svg>\n'
for key,body in I.items():
    ET.fromstring(svg(body))
    (OUT/'svg'/f'{key}.svg').write_text(svg(body),encoding='utf-8')
sprite='<svg xmlns="http://www.w3.org/2000/svg"><defs>'+''.join(f'<symbol id="tb-{k}" viewBox="0 0 24 24" fill="none">{b}</symbol>' for k,b in I.items())+'</defs></svg>\n'
ET.fromstring(sprite)
(OUT/'trailbook-sprite.svg').write_text(sprite,encoding='utf-8')
manifest={'name':'Trailbook B','version':'1.1.0','date':'2026-11-14','viewBox':'0 0 24 24','color':'currentColor','fallback':'other','catalogSource':'http://localhost:8099/api/types','count':len(I),'groups':CAT['groups'],'icons':[{k:t[k] for k in ['key','group','en','pl','indoor']}|{'file':f'svg/{t["key"]}.svg','symbol':f'tb-{t["key"]}'} for t in CAT['types']]}
(OUT/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
(ROOT/'source/icon-data.json').write_text(json.dumps({'groups':CAT['groups'],'icons':[{'key':t['key'],'group':t['group'],'pl':t['pl'],'en':t['en'],'body':I[t['key']]} for t in CAT['types']]},ensure_ascii=False),encoding='utf-8')
print(f'Generated {len(I)} SVG icons, sprite and manifest.')

# Rebuild the browser helper and preview from the same artwork.
data=json.loads((ROOT/'source/icon-data.json').read_text(encoding='utf-8'))
helper=(ROOT/'source/helper.template.js').read_text(encoding='utf-8').replace('__BODIES__',json.dumps({i['key']:i['body'] for i in data['icons']},ensure_ascii=False))
(ROOT/'trailbook-icons.js').write_text(helper,encoding='utf-8')
fragment=(ROOT/'source/gallery.template.html').read_text(encoding='utf-8').replace('__DATA__',json.dumps(data,ensure_ascii=False).replace('</','<'+chr(92)+'/'))
prefix=(ROOT/'source/preview-prefix.txt').read_text(encoding='utf-8')
(ROOT/'preview.html').write_text(prefix+fragment+'</main></body></html>',encoding='utf-8')
