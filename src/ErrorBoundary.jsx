import { Component } from "react";
export default class ErrorBoundary extends Component {
  constructor(p){ super(p); this.state = {err:null}; }
  static getDerivedStateFromError(err){ return {err}; }
  render(){
    if (this.state.err) {
      return <pre style={{whiteSpace:"pre-wrap", color:"crimson", padding:16}}>
{String(this.state.err?.stack || this.state.err)}
      </pre>;
    }
    return this.props.children;
  }
}



