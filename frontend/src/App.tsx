import {useState} from 'react';
import {Stage, Layer, Rect} from 'react-konva';

export default function App() {
  const [color, setColor] = useState('#00a8e8');
  
  return (
    <Stage width={600} height={400}>
      <Layer>
        <Rect
          x={50} y={50} width={120} height={80}
          fill={color} draggable
          onClick={() => setColor(color === '#00a8e8' ? '#ff7a00' : '#00a8e8')}
        />
      </Layer>
    </Stage>
  );
}