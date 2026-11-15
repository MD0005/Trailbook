from pathlib import Path
import json
ROOT=Path(__file__).resolve().parents[1]
data=json.loads((ROOT/'source/icon-data.json').read_text(encoding='utf-8'))
for icon in data['icons']:
    for folder,size in [('master',None),('20',20),('32',32)]:
        attrs=f' width="{size}" height="{size}"' if size else ''
        svg=f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"{attrs} fill="none" stroke="none">{icon["body"]}</svg>\n'
        (ROOT/folder/(icon['key']+'.svg')).write_text(svg,encoding='utf-8')
sprite='<svg xmlns="http://www.w3.org/2000/svg"><defs>'+''.join(f'<symbol id="tbm-{i["key"]}" viewBox="0 0 24 24" fill="none" stroke="none">{i["body"]}</symbol>' for i in data['icons'])+'</defs></svg>'
(ROOT/'metric-sprite.svg').write_text(sprite,encoding='utf-8')
bodies={i['key']:i['body'] for i in data['icons']}
(ROOT/'metric-icons.js').write_text((ROOT/'source/helper.template.js').read_text(encoding='utf-8').replace('__BODIES__',json.dumps(bodies,ensure_ascii=False)),encoding='utf-8')
fragment=(ROOT/'source/gallery.template.html').read_text(encoding='utf-8').replace('__DATA__',json.dumps(data,ensure_ascii=False).replace('</','<'+chr(92)+'/'))
(ROOT/'preview.html').write_text((ROOT/'source/preview-prefix.txt').read_text(encoding='utf-8')+fragment+'</main></body></html>',encoding='utf-8')
